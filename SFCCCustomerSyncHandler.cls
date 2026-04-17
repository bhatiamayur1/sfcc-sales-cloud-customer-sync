/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   SFCC → Salesforce Sales Cloud Customer Sync Accelerator       ║
 * ║   Apex: SFCCCustomerSyncHandler.cls                             ║
 * ║                                                                  ║
 * ║   Processes Contact and Lead records synced from SFCC:          ║
 * ║     • Scores contacts by purchase behaviour (RFM model)         ║
 * ║     • Assigns Account (B2B) or leaves standalone (B2C)         ║
 * ║     • Fires Campaign Member addition for qualifying segments    ║
 * ║     • Triggers Push Notification to SFCC on CRM-side changes   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */
public class SFCCCustomerSyncHandler {

    /* ════════════════════════════════════════════════════════
       RFM SCORING  (Recency · Frequency · Monetary)
       Called by Contact trigger after purchase metrics update
       ════════════════════════════════════════════════════════ */

    /**
     * Compute and persist an RFM score for a batch of Contacts.
     * Score ranges 1–5 per dimension; stored as sfcc_rfm_score__c
     * (e.g. "5-4-3" = high recency, high frequency, mid monetary)
     *
     * @param contactIds — Set of Contact IDs to score
     */
    public static void scoreContactsRFM(Set<Id> contactIds) {
        List<Contact> contacts = [
            SELECT  Id,
                    sfcc_order_count__c,
                    sfcc_lifetime_value__c,
                    sfcc_last_order_date__c,
                    sfcc_high_value_customer__c,
                    sfcc_rfm_score__c
            FROM    Contact
            WHERE   Id IN :contactIds
        ];

        // Normalise across all contacts in the batch
        Decimal maxLTV   = 0;
        Decimal maxCount = 0;
        for (Contact c : contacts) {
            if (c.sfcc_lifetime_value__c != null && c.sfcc_lifetime_value__c > maxLTV)
                maxLTV = c.sfcc_lifetime_value__c;
            if (c.sfcc_order_count__c != null && c.sfcc_order_count__c > maxCount)
                maxCount = c.sfcc_order_count__c;
        }

        List<Contact> toUpdate = new List<Contact>();
        for (Contact c : contacts) {
            Integer rScore = scoreRecency(c.sfcc_last_order_date__c);
            Integer fScore = maxCount > 0 ? scoreNorm(c.sfcc_order_count__c, maxCount) : 1;
            Integer mScore = maxLTV   > 0 ? scoreNorm(c.sfcc_lifetime_value__c, maxLTV) : 1;

            String rfm = rScore + '-' + fScore + '-' + mScore;
            Integer total = rScore + fScore + mScore;

            c.sfcc_rfm_score__c    = rfm;
            c.sfcc_rfm_total__c    = total;
            c.sfcc_rfm_segment__c  = classifySegment(rScore, fScore, mScore);
            toUpdate.add(c);
        }

        if (!toUpdate.isEmpty()) {
            update toUpdate;
        }
    }

    private static Integer scoreRecency(Date lastOrderDate) {
        if (lastOrderDate == null) return 1;
        Integer days = lastOrderDate.daysBetween(Date.today());
        if (days <= 30)  return 5;
        if (days <= 90)  return 4;
        if (days <= 180) return 3;
        if (days <= 365) return 2;
        return 1;
    }

    private static Integer scoreNorm(Decimal value, Decimal max) {
        if (value == null || max == 0) return 1;
        Decimal pct = value / max;
        if (pct >= 0.8) return 5;
        if (pct >= 0.6) return 4;
        if (pct >= 0.4) return 3;
        if (pct >= 0.2) return 2;
        return 1;
    }

    private static String classifySegment(Integer r, Integer f, Integer m) {
        Integer total = r + f + m;
        if (r == 5 && total >= 13) return 'Champions';
        if (r >= 4 && f >= 4)      return 'Loyal Customers';
        if (r == 5 && f <= 2)      return 'Recent Customers';
        if (r >= 3 && m >= 4)      return 'Potential Loyalists';
        if (r <= 2 && f >= 4)      return 'At Risk';
        if (r == 1 && f == 1)      return 'Lost';
        if (total >= 10)           return 'Need Attention';
        return 'Prospects';
    }

    /* ════════════════════════════════════════════════════════
       CAMPAIGN MEMBERSHIP
       Add high-value / at-risk contacts to Campaigns
       ════════════════════════════════════════════════════════ */

    /**
     * Add contacts to relevant Campaigns based on RFM segment.
     * Campaign External IDs must match the SFCC segment names.
     *
     * @param contactIds — contact IDs to process
     */
    public static void assignCampaignMembership(Set<Id> contactIds) {
        List<Contact> contacts = [
            SELECT Id, sfcc_rfm_segment__c
            FROM   Contact
            WHERE  Id IN :contactIds
            AND    sfcc_rfm_segment__c != null
        ];

        if (contacts.isEmpty()) return;

        // Get campaigns keyed by segment name
        Set<String> segmentNames = new Set<String>();
        for (Contact c : contacts) segmentNames.add(c.sfcc_rfm_segment__c);

        Map<String, Id> campaignBySegment = new Map<String, Id>();
        for (Campaign camp : [
            SELECT Id, sfcc_target_segment__c
            FROM Campaign
            WHERE sfcc_target_segment__c IN :segmentNames
            AND   IsActive = true
        ]) {
            campaignBySegment.put(camp.sfcc_target_segment__c, camp.Id);
        }

        // Avoid duplicate members
        Set<String> existingKeys = new Set<String>();
        for (CampaignMember cm : [
            SELECT CampaignId, ContactId
            FROM   CampaignMember
            WHERE  ContactId IN :contactIds
        ]) {
            existingKeys.add(cm.CampaignId + ':' + cm.ContactId);
        }

        List<CampaignMember> toInsert = new List<CampaignMember>();
        for (Contact c : contacts) {
            Id campId = campaignBySegment.get(c.sfcc_rfm_segment__c);
            if (campId == null) continue;
            String key = campId + ':' + c.Id;
            if (!existingKeys.contains(key)) {
                toInsert.add(new CampaignMember(
                    CampaignId = campId,
                    ContactId  = c.Id,
                    Status     = 'Sent'
                ));
                existingKeys.add(key);
            }
        }

        if (!toInsert.isEmpty()) {
            insert toInsert;
        }
    }

    /* ════════════════════════════════════════════════════════
       PUSH NOTIFICATION TO SFCC
       Notify SFCC when CRM-side fields change
       (e.g. loyalty tier updated by CS rep)
       ════════════════════════════════════════════════════════ */

    @future(callout=true)
    public static void pushContactUpdateToSFCC(Id contactId) {
        Contact c = [
            SELECT  Id, sfcc_customer_no__c, sfcc_rfm_segment__c,
                    sfcc_rfm_score__c, sfcc_loyalty_tier__c
            FROM    Contact
            WHERE   Id = :contactId
            LIMIT 1
        ];

        if (String.isBlank(c.sfcc_customer_no__c)) return;

        SFCC_Integration_Config__mdt cfg = [
            SELECT SFCC_Base_URL__c, Webhook_Secret__c
            FROM   SFCC_Integration_Config__mdt
            WHERE  DeveloperName = 'Default'
            LIMIT 1
        ];

        Map<String, Object> payload = new Map<String, Object>{
            'customerNo'    => c.sfcc_customer_no__c,
            'sfContactId'   => contactId,
            'updatedFields' => new Map<String, Object>{
                'loyaltyTier' => c.sfcc_loyalty_tier__c,
                'crmSegment'  => c.sfcc_rfm_segment__c,
                'rfmScore'    => c.sfcc_rfm_score__c
            }
        };

        HttpRequest req = new HttpRequest();
        req.setEndpoint(cfg.SFCC_Base_URL__c + '/SalesCloudSync-SFWebhook');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('x-sf-webhook-secret', cfg.Webhook_Secret__c);
        req.setBody(JSON.serialize(payload));
        req.setTimeout(10000);

        try {
            HttpResponse res = new Http().send(req);
            System.debug('SFCC webhook response: ' + res.getStatusCode() + ' ' + res.getBody());
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'SFCC webhook failed: ' + e.getMessage());
        }
    }

    /* ════════════════════════════════════════════════════════
       PRODUCT AFFINITY PARSING
       Convert SFCC semicolon-delimited affinity tag string
       into a structured set for Einstein or Campaign targeting
       ════════════════════════════════════════════════════════ */

    public static List<String> parseAffinityTags(String affinityField) {
        if (String.isBlank(affinityField)) return new List<String>();
        return affinityField.split(';');
    }

    /* ════════════════════════════════════════════════════════
       LEAD DEDUPLICATION HELPER
       Merges duplicate Leads created by multiple guest orders
       ════════════════════════════════════════════════════════ */

    public static void deduplicateLeadsByEmail(String email) {
        List<Lead> leads = [
            SELECT Id, CreatedDate, sfcc_first_order_total__c
            FROM   Lead
            WHERE  Email = :email
            AND    IsConverted = false
            ORDER BY CreatedDate ASC
        ];

        if (leads.size() <= 1) return;

        // Keep the oldest; merge order totals onto it then delete duplicates
        Lead master = leads[0];
        Decimal totalOrders = 0;
        for (Lead l : leads) totalOrders += (l.sfcc_first_order_total__c != null
            ? l.sfcc_first_order_total__c : 0);

        master.sfcc_first_order_total__c = totalOrders;
        update master;

        List<Lead> toDelete = new List<Lead>();
        for (Integer i = 1; i < leads.size(); i++) toDelete.add(leads.get(i));
        if (!toDelete.isEmpty()) delete toDelete;
    }
}
