/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   SFCC → Salesforce Sales Cloud Customer Sync Accelerator       ║
 * ║   Reference: SalesforceCustomFields.js                          ║
 * ║                                                                  ║
 * ║   All custom fields required on Salesforce standard objects.    ║
 * ║   Create via Setup > Object Manager > [Object] > Fields         ║
 * ║   or deploy via Metadata API / SFDX.                            ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

module.exports = {

    /* ════════════════════════════════════════════════════════
       CONTACT  — primary sync target for registered customers
       ════════════════════════════════════════════════════════ */
    Contact: {
        // Identity & correlation
        sfcc_customer_no__c     : { type: 'Text(100)',    externalId: true, unique: true, label: 'SFCC Customer No.' },
        sfcc_site_id__c         : { type: 'Text(100)',    label: 'SFCC Site ID' },
        sfcc_locale__c          : { type: 'Text(50)',     label: 'SFCC Locale' },
        sfcc_gender__c          : { type: 'Text(20)',     label: 'SFCC Gender' },
        sfcc_customer_group__c  : { type: 'Text(255)',    label: 'SFCC Customer Groups (;-separated)' },

        // Dates
        sfcc_registered_at__c      : { type: 'DateTime',  label: 'SFCC Registered At' },
        sfcc_last_login__c         : { type: 'DateTime',  label: 'SFCC Last Login' },
        sfcc_last_profile_update__c: { type: 'DateTime',  label: 'SFCC Last Profile Update' },
        sfcc_opt_out_date__c       : { type: 'DateTime',  label: 'SFCC Opt-Out Date' },
        sfcc_opt_out_channel__c    : { type: 'Text(100)', label: 'SFCC Opt-Out Channel' },
        sfcc_acquisition_date__c   : { type: 'Date',      label: 'SFCC Acquisition Date' },

        // Engagement
        sfcc_login_count__c        : { type: 'Number(18,0)', label: 'SFCC Login Count' },
        sfcc_newsletter_opt_in__c  : { type: 'Checkbox',    label: 'SFCC Newsletter Opt-In' },
        sfcc_registration_source__c: { type: 'Text(100)',   label: 'SFCC Registration Source' },

        // Purchase behaviour — updated after every order
        sfcc_lifetime_value__c     : { type: 'Currency(16,2)', label: 'SFCC Lifetime Value' },
        sfcc_order_count__c        : { type: 'Number(18,0)',   label: 'SFCC Order Count' },
        sfcc_avg_order_value__c    : { type: 'Currency(16,2)', label: 'SFCC Avg. Order Value' },
        sfcc_last_order_date__c    : { type: 'Date',           label: 'SFCC Last Order Date' },
        sfcc_product_affinity__c   : { type: 'Text(1000)',     label: 'SFCC Product Affinity Tags (;-separated)' },
        sfcc_high_value_customer__c: { type: 'Checkbox',       label: 'SFCC High-Value Customer' },
        sfcc_last_order_total__c   : { type: 'Currency(16,2)', label: 'SFCC Last Order Total' },

        // RFM scoring — computed by Apex trigger
        sfcc_rfm_score__c          : { type: 'Text(20)',   label: 'SFCC RFM Score (R-F-M)' },
        sfcc_rfm_total__c          : { type: 'Number(3,0)', label: 'SFCC RFM Total' },
        sfcc_rfm_segment__c        : { type: 'Text(50)',   label: 'SFCC RFM Segment' },

        // Loyalty
        sfcc_loyalty_tier__c       : { type: 'Text(50)',   label: 'SFCC Loyalty Tier' },

        // Sync metadata
        sfcc_delta_sync_at__c      : { type: 'DateTime',  label: 'SFCC Delta Sync At' },
        sfcc_retry_sync_at__c      : { type: 'DateTime',  label: 'SFCC Retry Sync At' },
        sfcc_manual_sync_at__c     : { type: 'DateTime',  label: 'SFCC Manual Sync At' }
    },

    /* ════════════════════════════════════════════════════════
       LEAD  — guest checkout customers
       ════════════════════════════════════════════════════════ */
    Lead: {
        sfcc_site_id__c            : { type: 'Text(100)',    label: 'SFCC Site ID' },
        sfcc_is_guest__c           : { type: 'Checkbox',    label: 'SFCC Guest Customer' },
        sfcc_first_order_no__c     : { type: 'Text(100)',   label: 'SFCC First Order No.' },
        sfcc_first_order_total__c  : { type: 'Currency(16,2)', label: 'SFCC First Order Total' },
        sfcc_currency__c           : { type: 'Text(10)',    label: 'SFCC Currency' },
        sfcc_guest_order_at__c     : { type: 'DateTime',   label: 'SFCC Guest Order Date' }
    },

    /* ════════════════════════════════════════════════════════
       OPPORTUNITY  — one per SFCC order
       ════════════════════════════════════════════════════════ */
    Opportunity: {
        sfcc_order_no__c          : { type: 'Text(100)',    externalId: true, unique: true, label: 'SFCC Order No.' },
        sfcc_site_id__c           : { type: 'Text(100)',    label: 'SFCC Site ID' },
        sfcc_customer_no__c       : { type: 'Text(100)',    label: 'SFCC Customer No.' },
        sfcc_customer_email__c    : { type: 'Email',        label: 'SFCC Customer Email' },
        sfcc_is_guest_order__c    : { type: 'Checkbox',    label: 'SFCC Guest Order' },
        sfcc_subtotal__c          : { type: 'Currency(16,2)', label: 'SFCC Subtotal' },
        sfcc_tax_total__c         : { type: 'Currency(16,2)', label: 'SFCC Tax Total' },
        sfcc_shipping_total__c    : { type: 'Currency(16,2)', label: 'SFCC Shipping Total' },
        sfcc_shipping_method__c   : { type: 'Text(100)',    label: 'SFCC Shipping Method' },
        sfcc_payment_method__c    : { type: 'Text(100)',    label: 'SFCC Payment Method' },
        sfcc_order_item_count__c  : { type: 'Number(5,0)', label: 'SFCC Item Count' }
    },

    /* ════════════════════════════════════════════════════════
       OPPORTUNITYLINEITEM  — one per SFCC line item
       ════════════════════════════════════════════════════════ */
    OpportunityLineItem: {
        sfcc_product_id__c : { type: 'Text(100)', label: 'SFCC Product ID' },
        sfcc_sku__c        : { type: 'Text(100)', label: 'SFCC SKU / UPC' },
        sfcc_category__c   : { type: 'Text(255)', label: 'SFCC Product Category' }
    },

    /* ════════════════════════════════════════════════════════
       CAMPAIGN  — segment-linked campaign
       ════════════════════════════════════════════════════════ */
    Campaign: {
        sfcc_target_segment__c : { type: 'Text(100)', label: 'SFCC Target RFM Segment' }
    }
};
