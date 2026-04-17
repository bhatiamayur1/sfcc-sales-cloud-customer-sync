/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   SFCC → Salesforce Sales Cloud Customer Sync Accelerator       ║
 * ║   LWC: customerInsightsPanel.js                                 ║
 * ║   Wire Contact fields + format for the Commerce Insights UI     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */
import { LightningElement, api, wire, track } from 'lwc';
import { getRecord, getFieldValue }           from 'lightning/uiRecordApi';

import CUSTOMER_NO      from '@salesforce/schema/Contact.sfcc_customer_no__c';
import SITE_ID          from '@salesforce/schema/Contact.sfcc_site_id__c';
import LTV              from '@salesforce/schema/Contact.sfcc_lifetime_value__c';
import ORDER_COUNT      from '@salesforce/schema/Contact.sfcc_order_count__c';
import AVG_ORDER        from '@salesforce/schema/Contact.sfcc_avg_order_value__c';
import LAST_ORDER       from '@salesforce/schema/Contact.sfcc_last_order_date__c';
import AFFINITY         from '@salesforce/schema/Contact.sfcc_product_affinity__c';
import RFM_SCORE        from '@salesforce/schema/Contact.sfcc_rfm_score__c';
import RFM_SEGMENT      from '@salesforce/schema/Contact.sfcc_rfm_segment__c';
import LOYALTY_TIER     from '@salesforce/schema/Contact.sfcc_loyalty_tier__c';
import HIGH_VALUE       from '@salesforce/schema/Contact.sfcc_high_value_customer__c';
import REGISTERED_AT    from '@salesforce/schema/Contact.sfcc_registered_at__c';
import LAST_LOGIN       from '@salesforce/schema/Contact.sfcc_last_login__c';
import LOGIN_COUNT      from '@salesforce/schema/Contact.sfcc_login_count__c';
import NEWSLETTER_OPT   from '@salesforce/schema/Contact.sfcc_newsletter_opt_in__c';

const FIELDS = [
    CUSTOMER_NO, SITE_ID, LTV, ORDER_COUNT, AVG_ORDER, LAST_ORDER,
    AFFINITY, RFM_SCORE, RFM_SEGMENT, LOYALTY_TIER, HIGH_VALUE,
    REGISTERED_AT, LAST_LOGIN, LOGIN_COUNT, NEWSLETTER_OPT
];

const SFCC_BM_BASE = 'https://YOUR-ORG.commercecloud.salesforce.com/on/demandware.store/Sites-Site/default/ViewCustomer-Show?CustomerID=';

const SEGMENT_COLORS = {
    'Champions'          : '#0D7A2B',
    'Loyal Customers'    : '#0070D2',
    'Recent Customers'   : '#FF8C00',
    'Potential Loyalists': '#6B5EA8',
    'At Risk'            : '#C23934',
    'Lost'               : '#54698D',
    'Need Attention'     : '#E4A201',
    'Prospects'          : '#5867AC'
};

export default class CustomerInsightsPanel extends LightningElement {

    @api recordId;
    @track isLoading = true;

    _data = null;

    @wire(getRecord, { recordId: '$recordId', fields: FIELDS })
    wiredContact({ error, data }) {
        this.isLoading = false;
        if (data) this._data = data;
    }

    /* ── Field accessors ────────────────────────────────────── */
    _fv(field) { return this._data ? getFieldValue(this._data, field) : null; }

    get hasSFCCCustomer() { return !!this._fv(CUSTOMER_NO); }
    get sfccCustomerNo()  { return this._fv(CUSTOMER_NO) || '—'; }
    get sfccSiteId()      { return this._fv(SITE_ID)     || '—'; }
    get rfmScore()        { return this._fv(RFM_SCORE)   || '—'; }
    get rfmSegment()      { return this._fv(RFM_SEGMENT) || '—'; }
    get orderCount()      { return this._fv(ORDER_COUNT) || 0; }
    get loyaltyTier()     { return this._fv(LOYALTY_TIER) || 'Standard'; }
    get loginCount()      { return this._fv(LOGIN_COUNT) || 0; }

    get formattedLTV() {
        const v = this._fv(LTV) || 0;
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
    }

    get formattedAOV() {
        const v = this._fv(AVG_ORDER) || 0;
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
    }

    get lastOrderDate() {
        const d = this._fv(LAST_ORDER);
        return d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
    }

    get registeredAt() {
        const d = this._fv(REGISTERED_AT);
        return d ? new Date(d).toLocaleDateString() : '—';
    }

    get lastLogin() {
        const d = this._fv(LAST_LOGIN);
        return d ? new Date(d).toLocaleDateString() : '—';
    }

    get hasAffinityTags() { return this.affinityTags.length > 0; }

    get affinityTags() {
        const raw = this._fv(AFFINITY);
        if (!raw) return [];
        return raw.split(';').filter(Boolean).map((t, i) => ({ id: i, name: t.trim() }));
    }

    get newsletterIcon()    { return this._fv(NEWSLETTER_OPT) ? 'utility:check' : 'utility:close'; }
    get newsletterVariant() { return this._fv(NEWSLETTER_OPT) ? 'success' : 'error'; }
    get highValueIcon()     { return this._fv(HIGH_VALUE) ? 'utility:ribbon' : 'utility:close'; }
    get highValueVariant()  { return this._fv(HIGH_VALUE) ? 'warning' : 'error'; }

    get sfccCustomerURL() {
        return SFCC_BM_BASE + encodeURIComponent(this.sfccCustomerNo);
    }

    get segmentColor() {
        return SEGMENT_COLORS[this.rfmSegment] || '#5867AC';
    }

    /* ── Lifecycle ───────────────────────────────────────────── */
    renderedCallback() {
        // Apply dynamic segment colour via CSS custom property
        const banner = this.template.querySelector('.segment-banner');
        if (banner) banner.style.setProperty('--segment-color', this.segmentColor);
    }
}
