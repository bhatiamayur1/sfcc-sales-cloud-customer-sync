/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   SFCC → Salesforce Sales Cloud Customer Sync Accelerator       ║
 * ║   Trigger: SFCCContactTrigger.trigger                           ║
 * ║                                                                  ║
 * ║   Fires on Contact insert/update when SFCC fields change.       ║
 * ║   Delegates all logic to SFCCCustomerSyncHandler (thin trigger).║
 * ╚══════════════════════════════════════════════════════════════════╝
 */
trigger SFCCContactTrigger on Contact (after insert, after update) {

    Set<Id> toScore          = new Set<Id>();
    Set<Id> toNotifySFCC     = new Set<Id>();

    for (Contact newC : Trigger.new) {

        /* Skip non-SFCC contacts */
        if (String.isBlank(newC.sfcc_customer_no__c)) continue;

        Boolean isInsert = Trigger.isInsert;
        Contact oldC     = isInsert ? null : Trigger.oldMap.get(newC.Id);

        /* Score when purchase metrics change */
        Boolean metricsChanged = isInsert
            || newC.sfcc_lifetime_value__c  != oldC.sfcc_lifetime_value__c
            || newC.sfcc_order_count__c     != oldC.sfcc_order_count__c
            || newC.sfcc_last_order_date__c != oldC.sfcc_last_order_date__c;

        if (metricsChanged) toScore.add(newC.Id);

        /* Notify SFCC when CRM-owned fields change */
        Boolean crmFieldsChanged = !isInsert && (
            newC.sfcc_loyalty_tier__c != oldC.sfcc_loyalty_tier__c
        );
        if (crmFieldsChanged) toNotifySFCC.add(newC.Id);
    }

    if (!toScore.isEmpty()) {
        SFCCCustomerSyncHandler.scoreContactsRFM(toScore);
        SFCCCustomerSyncHandler.assignCampaignMembership(toScore);
    }

    for (Id cId : toNotifySFCC) {
        SFCCCustomerSyncHandler.pushContactUpdateToSFCC(cId);
    }
}
