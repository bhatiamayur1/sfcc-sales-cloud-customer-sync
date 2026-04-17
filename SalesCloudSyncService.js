'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   SFCC → Salesforce Sales Cloud Customer Sync Accelerator       ║
 * ║   Service: SalesCloudSyncService.js                             ║
 * ║                                                                  ║
 * ║   Handles all CRM synchronisation operations:                   ║
 * ║                                                                  ║
 * ║   CUSTOMER LIFECYCLE                                             ║
 * ║     • Registration  → upsert Contact (or Lead for guests)       ║
 * ║     • Profile edit  → patch Contact fields                      ║
 * ║     • Login         → update LastLoginDate__c, LoginCount__c    ║
 * ║     • Opt-out       → set HasOptedOutOfEmail = true             ║
 * ║                                                                  ║
 * ║   PURCHASE BEHAVIOUR                                             ║
 * ║     • Order placed  → Opportunity + OpportunityLineItems        ║
 * ║     • Lifetime value→ recalculate on Contact after each order   ║
 * ║     • Product affinity → update Product_Affinity__c tag list    ║
 * ║                                                                  ║
 * ║   LEAD LIFECYCLE                                                 ║
 * ║     • Guest checkout → create Lead                              ║
 * ║     • Lead converts when guest registers                        ║
 * ║                                                                  ║
 * ║   Auth: OAuth 2.0 Client Credentials (server-to-server)        ║
 * ║   Transport: Salesforce Composite / REST v59.0                  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');
var CacheMgr             = require('dw/system/CacheMgr');
var Logger               = require('dw/system/Logger').getLogger('SalesCloudSync', 'SalesCloudSync');
var Site                 = require('dw/system/Site');

/* ── Token cache (TTL configured in BM CacheMgr: 3300 s) ──────── */
var TOKEN_CACHE_KEY    = 'sc_access_token';
var TOKEN_CACHE_REGION = 'SalesCloudTokenCache';

/* ── Site preference IDs ───────────────────────────────────────── */
var PREFS = {
    SF_AUTH_URL    : 'scSFAuthURL',
    SF_REST_BASE   : 'scSFRestBaseURL',
    SF_API_VERSION : 'scSFAPIVersion',      // default v59.0
    GUEST_AS_LEAD  : 'scGuestCheckoutAsLead', // boolean
    LTV_THRESHOLD  : 'scHighValueCustomerThreshold' // numeric
};

function pref(key) {
    return Site.getCurrent().getCustomPreferenceValue(key);
}

function apiVersion() {
    return pref(PREFS.SF_API_VERSION) || 'v59.0';
}

/* ════════════════════════════════════════════════════════════════
   §1  AUTHENTICATION
   ════════════════════════════════════════════════════════════════ */

function getAccessToken() {
    var cache  = CacheMgr.getCache(TOKEN_CACHE_REGION);
    var cached = cache.get(TOKEN_CACHE_KEY);
    if (cached) return cached;

    var svc = LocalServiceRegistry.createService('salescloud.rest.auth', {
        createRequest: function (svc) {
            svc.setRequestMethod('POST');
            svc.addHeader('Content-Type', 'application/x-www-form-urlencoded');
            return [
                'grant_type=client_credentials',
                'client_id='     + encodeURIComponent(svc.configuration.credential.user),
                'client_secret=' + encodeURIComponent(svc.configuration.credential.password)
            ].join('&');
        },
        parseResponse  : function (svc, res) { return JSON.parse(res.text); },
        filterLogMessage: function (msg) {
            return msg.replace(/client_secret=[^&\s]+/, 'client_secret=***');
        }
    });

    var result = svc.call();
    if (result.ok && result.object && result.object.access_token) {
        cache.put(TOKEN_CACHE_KEY, result.object.access_token);
        return result.object.access_token;
    }
    throw new Error('SalesCloud | OAuth token failed: ' + JSON.stringify(result.object));
}

/* ════════════════════════════════════════════════════════════════
   §2  GENERIC REST HELPER
   ════════════════════════════════════════════════════════════════ */

function sfCall(path, method, body) {
    var token   = getAccessToken();
    var baseURL = pref(PREFS.SF_REST_BASE) || '';
    var ver     = apiVersion();

    var svc = LocalServiceRegistry.createService('salescloud.rest.api', {
        createRequest: function (svc, p) {
            svc.setRequestMethod(p.method);
            svc.addHeader('Content-Type', 'application/json');
            svc.addHeader('Authorization', 'Bearer ' + p.token);
            svc.setURL(baseURL + p.path.replace('{version}', ver));
            return p.body ? JSON.stringify(p.body) : null;
        },
        parseResponse  : function (svc, res) {
            try { return JSON.parse(res.text); } catch (e) { return { raw: res.text }; }
        },
        filterLogMessage: function (msg) {
            return msg.replace(/Bearer [A-Za-z0-9._\-]+/, 'Bearer ***');
        }
    });

    return svc.call({ path: path, method: method, body: body, token: token });
}

/* ════════════════════════════════════════════════════════════════
   §3  SOQL QUERY HELPER
   ════════════════════════════════════════════════════════════════ */

function soqlQuery(soql) {
    var path = '/services/data/{version}/query?q=' + encodeURIComponent(soql);
    var res  = sfCall(path, 'GET', null);
    if (res.ok && res.object) return res.object;
    return null;
}

/* ════════════════════════════════════════════════════════════════
   §4  CONTACT OPERATIONS
   ════════════════════════════════════════════════════════════════ */

/**
 * Build Contact payload from SFCC customer profile.
 * Maps every standard Commerce field to its CRM equivalent.
 *
 * @param  {dw.customer.Profile} profile
 * @param  {Object}              extras   — optional additional fields
 * @returns {Object}
 */
function buildContactPayload(profile, extras) {
    var payload = {
        // Standard Contact fields
        Email          : profile.email,
        FirstName      : profile.firstName      || '',
        LastName       : profile.lastName        || 'Unknown',
        Phone          : profile.phoneHome       || profile.phoneMobile || '',
        MobilePhone    : profile.phoneMobile     || '',
        Birthdate      : profile.birthday ? formatDate(profile.birthday) : null,

        // SFCC custom fields on Contact
        sfcc_customer_no__c       : profile.customerNo,
        sfcc_customer_group__c    : getCustomerGroupNames(profile.customer),
        sfcc_site_id__c           : Site.getCurrent().ID,
        sfcc_registered_at__c     : profile.creationDate
            ? formatDateTime(profile.creationDate) : null,
        sfcc_last_login__c        : profile.lastLoginTime
            ? formatDateTime(profile.lastLoginTime) : null,
        sfcc_locale__c            : profile.customer.activeData
            ? profile.customer.activeData.lastVisitedLocale || '' : '',
        sfcc_gender__c            : profile.gender ? profile.gender.value : '',

        // Marketing preferences
        HasOptedOutOfEmail        : !profile.email || false,

        // Loyalty / segment
        sfcc_loyalty_tier__c      : profile.custom && profile.custom.loyaltyTier
            ? profile.custom.loyaltyTier : '',
        sfcc_newsletter_opt_in__c : profile.custom && profile.custom.newsletterOptIn
            ? true : false
    };

    // Merge any extras (LTV, affinity, etc.)
    if (extras) {
        Object.keys(extras).forEach(function (k) { payload[k] = extras[k]; });
    }

    return payload;
}

/**
 * Upsert a Contact in Sales Cloud using sfcc_customer_no__c as
 * the external ID. Creates on first sync, patches on subsequent.
 *
 * @param  {dw.customer.Profile} profile
 * @param  {Object}              extras
 * @returns {{ ok: boolean, contactId: string|null, created: boolean, errorMessage: string|null }}
 */
function upsertContact(profile, extras) {
    var payload      = buildContactPayload(profile, extras);
    var customerNo   = profile.customerNo;
    var path         = '/services/data/{version}/sobjects/Contact/sfcc_customer_no__c/'
                     + encodeURIComponent(customerNo);

    try {
        var result = sfCall(path, 'PATCH', payload);

        // PATCH returns 201 (created) or 204 (updated); both are "ok" in dw.svc
        if (result.ok) {
            var created   = result.object && result.object.id ? true : false;
            var contactId = result.object && result.object.id ? result.object.id : null;

            Logger.info('SalesCloud | Contact upserted [{0}] for customer: {1}',
                created ? 'CREATED' : 'UPDATED', customerNo);

            return { ok: true, contactId: contactId, created: created };
        }

        Logger.error('SalesCloud | Contact upsert failed [{0}]: {1}',
            customerNo, JSON.stringify(result.object));
        return { ok: false, contactId: null, created: false,
            errorMessage: JSON.stringify(result.object) };

    } catch (e) {
        Logger.error('SalesCloud | upsertContact exception [{0}]: {1}', customerNo, e.message);
        return { ok: false, contactId: null, created: false, errorMessage: e.message };
    }
}

/**
 * Look up a Contact by SFCC customer number.
 *
 * @param  {string} customerNo
 * @returns {{ ok: boolean, contactId: string|null, data: Object|null }}
 */
function getContactByCustomerNo(customerNo) {
    var soql = 'SELECT Id, Email, FirstName, LastName, sfcc_lifetime_value__c, '
             + 'sfcc_order_count__c, sfcc_last_order_date__c '
             + 'FROM Contact WHERE sfcc_customer_no__c = \''
             + escapeSOQL(customerNo) + '\' LIMIT 1';

    try {
        var data = soqlQuery(soql);
        if (data && data.records && data.records.length > 0) {
            return { ok: true, contactId: data.records[0].Id, data: data.records[0] };
        }
        return { ok: false, contactId: null, data: null,
            errorMessage: 'Contact not found for customer: ' + customerNo };
    } catch (e) {
        return { ok: false, contactId: null, data: null, errorMessage: e.message };
    }
}

/**
 * Update Contact purchase metrics (LTV, order count, last order date,
 * product affinity tags). Called after every successful order.
 *
 * @param  {string} customerNo
 * @param  {Object} metrics  — { lifetimeValue, orderCount, lastOrderDate, affinityTags }
 */
function updateContactMetrics(customerNo, metrics) {
    var path = '/services/data/{version}/sobjects/Contact/sfcc_customer_no__c/'
             + encodeURIComponent(customerNo);

    var payload = {
        sfcc_lifetime_value__c  : metrics.lifetimeValue  || 0,
        sfcc_order_count__c     : metrics.orderCount     || 0,
        sfcc_last_order_date__c : metrics.lastOrderDate  || null,
        sfcc_product_affinity__c: (metrics.affinityTags || []).join(';'),
        sfcc_avg_order_value__c : metrics.orderCount > 0
            ? (metrics.lifetimeValue / metrics.orderCount).toFixed(2) : 0,
        sfcc_high_value_customer__c: metrics.lifetimeValue >= (pref(PREFS.LTV_THRESHOLD) || 1000)
    };

    try {
        var result = sfCall(path, 'PATCH', payload);
        if (result.ok) {
            Logger.info('SalesCloud | Contact metrics updated for: {0}', customerNo);
            return { ok: true };
        }
        Logger.error('SalesCloud | Metrics update failed [{0}]: {1}',
            customerNo, result.errorMessage);
        return { ok: false, errorMessage: result.errorMessage };
    } catch (e) {
        Logger.error('SalesCloud | updateContactMetrics exception: {0}', e.message);
        return { ok: false, errorMessage: e.message };
    }
}

/* ════════════════════════════════════════════════════════════════
   §5  LEAD OPERATIONS  (guest customers)
   ════════════════════════════════════════════════════════════════ */

/**
 * Create or update a Lead for a guest checkout customer.
 * Leads are converted to Contacts when the customer registers.
 *
 * @param  {Object} guestData  — { email, firstName, lastName, phone, orderNo, orderTotal, currency }
 * @returns {{ ok: boolean, leadId: string|null, errorMessage: string|null }}
 */
function upsertGuestLead(guestData) {
    // Check if Lead already exists (by email)
    var existingSOQL = 'SELECT Id FROM Lead WHERE Email = \''
        + escapeSOQL(guestData.email) + '\' AND IsConverted = false LIMIT 1';
    var existing = soqlQuery(existingSOQL);

    var payload = {
        Email         : guestData.email,
        FirstName     : guestData.firstName  || '',
        LastName      : guestData.lastName   || 'Guest',
        Phone         : guestData.phone      || '',
        Company       : 'SFCC Guest Customer',
        LeadSource    : 'SFCC Guest Checkout',
        Status        : 'Open - Not Contacted',
        sfcc_site_id__c      : Site.getCurrent().ID,
        sfcc_is_guest__c     : true,
        sfcc_first_order_no__c  : guestData.orderNo    || '',
        sfcc_first_order_total__c: guestData.orderTotal || 0,
        sfcc_currency__c     : guestData.currency || 'USD',
        sfcc_guest_order_at__c  : new Date().toISOString()
    };

    try {
        var result;
        var leadId;

        if (existing && existing.records && existing.records.length > 0) {
            // Update existing lead
            leadId = existing.records[0].Id;
            result = sfCall('/services/data/{version}/sobjects/Lead/' + leadId, 'PATCH', payload);
            Logger.info('SalesCloud | Guest Lead updated: {0} for {1}', leadId, guestData.email);
        } else {
            // Create new lead
            result = sfCall('/services/data/{version}/sobjects/Lead/', 'POST', payload);
            leadId = result.object && result.object.id ? result.object.id : null;
            Logger.info('SalesCloud | Guest Lead created: {0} for {1}', leadId, guestData.email);
        }

        return result.ok
            ? { ok: true, leadId: leadId }
            : { ok: false, leadId: null, errorMessage: result.errorMessage };

    } catch (e) {
        Logger.error('SalesCloud | upsertGuestLead exception: {0}', e.message);
        return { ok: false, leadId: null, errorMessage: e.message };
    }
}

/**
 * Convert a Lead to Contact when a guest customer registers.
 * Uses the Salesforce Lead Convert API.
 *
 * @param  {string} leadId
 * @param  {string} customerNo  — SFCC customer number for the new Contact
 * @returns {{ ok: boolean, contactId: string|null, errorMessage: string|null }}
 */
function convertLeadToContact(leadId, customerNo) {
    var path    = '/services/data/{version}/sobjects/Lead/' + leadId + '/convert';
    var payload = {
        convertedStatus  : 'Qualified',
        doNotCreateOpportunity: true,
        overwriteLeadSource   : false
    };

    try {
        var result = sfCall(path, 'POST', payload);
        if (result.ok && result.object && result.object.contactId) {
            var contactId = result.object.contactId;

            // Stamp SFCC customer number on the new Contact
            sfCall(
                '/services/data/{version}/sobjects/Contact/' + contactId,
                'PATCH',
                { sfcc_customer_no__c: customerNo }
            );

            Logger.info('SalesCloud | Lead {0} converted → Contact {1}', leadId, contactId);
            return { ok: true, contactId: contactId };
        }
        return { ok: false, contactId: null,
            errorMessage: result.errorMessage || 'Lead conversion failed' };
    } catch (e) {
        Logger.error('SalesCloud | convertLeadToContact exception: {0}', e.message);
        return { ok: false, contactId: null, errorMessage: e.message };
    }
}

/* ════════════════════════════════════════════════════════════════
   §6  OPPORTUNITY (PURCHASE) SYNC
   ════════════════════════════════════════════════════════════════ */

/**
 * Create an Opportunity + OpportunityLineItems for an SFCC order.
 * Uses the Composite API for atomicity.
 *
 * @param  {dw.order.Order} order
 * @param  {string}         contactId  — Salesforce Contact ID (null for guest)
 * @returns {{ ok: boolean, opportunityId: string|null, errorMessage: string|null }}
 */
function createOrderOpportunity(order, contactId) {
    var ver = apiVersion();

    // Build line items
    var lineItems = [];
    var plis = order.allProductLineItems.iterator();
    while (plis.hasNext()) {
        var pli = plis.next();
        lineItems.push({
            Quantity        : pli.quantity.value,
            UnitPrice       : pli.basePrice.value,
            TotalPrice      : pli.adjustedNetPrice.value,
            Description     : pli.productName,
            sfcc_product_id__c : pli.productID,
            sfcc_sku__c        : pli.product ? pli.product.UPC || '' : '',
            sfcc_category__c   : getPrimaryCategory(pli)
        });
    }

    var oppPayload = {
        Name              : 'SFCC Order — ' + order.orderNo,
        StageName         : 'Closed Won',
        CloseDate         : formatDate(new Date()),
        Amount            : order.totalGrossPrice.value,
        CurrencyIsoCode   : order.currencyCode,
        LeadSource        : 'SFCC Storefront',
        ContactId         : contactId || null,

        sfcc_order_no__c       : order.orderNo,
        sfcc_site_id__c        : Site.getCurrent().ID,
        sfcc_customer_no__c    : order.customerNo || '',
        sfcc_customer_email__c : order.customerEmail,
        sfcc_is_guest_order__c : !order.customer || !order.customer.registered,
        sfcc_subtotal__c       : order.merchandizeTotalPrice.value,
        sfcc_tax_total__c      : order.totalTax.value,
        sfcc_shipping_total__c : order.shippingTotalPrice.value,
        sfcc_shipping_method__c: order.defaultShipment
            ? order.defaultShipment.shippingMethodID : '',
        sfcc_payment_method__c : order.paymentInstruments.length > 0
            ? order.paymentInstruments[0].paymentMethod : '',
        sfcc_order_item_count__c: order.allProductLineItems.size()
    };

    // Composite API: create Opp then attach LineItems
    var compositeRequest = [{
        method      : 'POST',
        url         : '/services/data/' + ver + '/sobjects/Opportunity/',
        referenceId : 'newOpp',
        body        : oppPayload
    }].concat(lineItems.map(function (item, i) {
        return {
            method      : 'POST',
            url         : '/services/data/' + ver + '/sobjects/OpportunityLineItem/',
            referenceId : 'lineItem' + i,
            body        : Object.assign({}, item, { OpportunityId: '@{newOpp.id}' })
        };
    }));

    try {
        var result = sfCall('/services/data/{version}/composite', 'POST', {
            allOrNone       : true,
            compositeRequest: compositeRequest
        });

        if (result.ok) {
            var oppId = result.object
                && result.object.compositeResponse
                && result.object.compositeResponse[0]
                ? result.object.compositeResponse[0].body.id : null;

            Logger.info('SalesCloud | Opportunity created [{0}] for order {1}', oppId, order.orderNo);
            return { ok: true, opportunityId: oppId };
        }

        Logger.error('SalesCloud | Opportunity creation failed for order {0}: {1}',
            order.orderNo, result.errorMessage);
        return { ok: false, opportunityId: null, errorMessage: result.errorMessage };

    } catch (e) {
        Logger.error('SalesCloud | createOrderOpportunity exception: {0}', e.message);
        return { ok: false, opportunityId: null, errorMessage: e.message };
    }
}

/* ════════════════════════════════════════════════════════════════
   §7  PURCHASE BEHAVIOUR MAPPING
   ════════════════════════════════════════════════════════════════ */

/**
 * Compute purchase behaviour metrics from SFCC order history.
 * Called after each order to update Contact fields in Sales Cloud.
 *
 * @param  {dw.customer.Customer} customer
 * @param  {dw.order.Order}       latestOrder
 * @returns {Object} metrics object for updateContactMetrics()
 */
function computePurchaseBehaviour(customer, latestOrder) {
    var OrderMgr = require('dw/order/OrderMgr');
    var Order    = require('dw/order/Order');

    var lifetimeValue = 0;
    var orderCount    = 0;
    var categories    = {};

    try {
        var orders = OrderMgr.queryOrders(
            'customerEmail = {0} AND status != {1}',
            'creationDate desc',
            customer.profile.email,
            Order.ORDER_STATUS_CANCELLED
        );

        while (orders.hasNext()) {
            var o = orders.next();
            lifetimeValue += o.totalGrossPrice.value;
            orderCount++;

            // Accumulate category frequency
            var pliIter = o.allProductLineItems.iterator();
            while (pliIter.hasNext()) {
                var pli = pliIter.next();
                var cat = getPrimaryCategory(pli);
                if (cat) categories[cat] = (categories[cat] || 0) + 1;
            }
        }

        if (orders.close) orders.close();
    } catch (e) {
        Logger.warn('SalesCloud | computePurchaseBehaviour error: {0}', e.message);
    }

    // Sort categories by frequency; take top 5
    var sortedCategories = Object.keys(categories)
        .sort(function (a, b) { return categories[b] - categories[a]; })
        .slice(0, 5);

    return {
        lifetimeValue : lifetimeValue,
        orderCount    : orderCount,
        lastOrderDate : formatDate(new Date()),
        affinityTags  : sortedCategories,
        avgOrderValue : orderCount > 0 ? (lifetimeValue / orderCount) : 0
    };
}

/* ════════════════════════════════════════════════════════════════
   §8  BATCH SYNC HELPERS  (used by SalesCloudBatchSyncJob)
   ════════════════════════════════════════════════════════════════ */

/**
 * Upsert a batch of Contacts via the Salesforce Bulk v2 API.
 * Returns a job ID for monitoring.
 *
 * @param  {Array} contactPayloads  — array of Contact field maps
 * @returns {{ ok: boolean, jobId: string|null, errorMessage: string|null }}
 */
function bulkUpsertContacts(contactPayloads) {
    // Step 1: Create Bulk job
    var jobResult = sfCall('/services/data/{version}/jobs/ingest', 'POST', {
        object          : 'Contact',
        operation       : 'upsert',
        externalIdFieldName: 'sfcc_customer_no__c',
        contentType     : 'CSV',
        lineEnding      : 'LF'
    });

    if (!jobResult.ok || !jobResult.object || !jobResult.object.id) {
        return { ok: false, jobId: null, errorMessage: 'Failed to create Bulk job' };
    }

    var jobId = jobResult.object.id;

    // Step 2: Upload CSV data
    var csv = buildContactCSV(contactPayloads);
    var uploadResult = sfCall(
        '/services/data/{version}/jobs/ingest/' + jobId + '/batches',
        'PUT',
        csv   // raw CSV string — service must set Content-Type: text/csv
    );

    if (!uploadResult.ok) {
        return { ok: false, jobId: jobId, errorMessage: 'CSV upload failed' };
    }

    // Step 3: Close job (triggers processing)
    sfCall('/services/data/{version}/jobs/ingest/' + jobId, 'PATCH', { state: 'UploadComplete' });

    Logger.info('SalesCloud | Bulk upsert job created: {0} ({1} records)', jobId, contactPayloads.length);
    return { ok: true, jobId: jobId };
}

/**
 * Poll a Bulk v2 job and return its current state.
 * @param  {string} jobId
 */
function getBulkJobStatus(jobId) {
    var result = sfCall('/services/data/{version}/jobs/ingest/' + jobId, 'GET', null);
    return result.ok ? { ok: true, state: result.object.state, data: result.object } : { ok: false };
}

/* ════════════════════════════════════════════════════════════════
   §9  UTILITY FUNCTIONS
   ════════════════════════════════════════════════════════════════ */

function formatDate(d) {
    if (!d) return null;
    var date = d instanceof Date ? d : new Date(d);
    return date.toISOString().split('T')[0];
}

function formatDateTime(d) {
    if (!d) return null;
    var date = d instanceof Date ? d : new Date(d);
    return date.toISOString();
}

function escapeSOQL(val) {
    return (val || '').toString().replace(/'/g, "\\'");
}

function getPrimaryCategory(pli) {
    try {
        if (pli.product && pli.product.primaryCategory) {
            return pli.product.primaryCategory.displayName || '';
        }
    } catch (e) { /* ignore */ }
    return '';
}

function getCustomerGroupNames(customer) {
    try {
        var groups = [];
        var cgIter = customer.customerGroups.iterator();
        while (cgIter.hasNext()) {
            groups.push(cgIter.next().ID);
        }
        return groups.join(';');
    } catch (e) { return ''; }
}

function buildContactCSV(payloads) {
    if (!payloads || payloads.length === 0) return '';
    var headers = Object.keys(payloads[0]);
    var rows    = [headers.join(',')];
    payloads.forEach(function (p) {
        rows.push(headers.map(function (h) {
            var v = p[h] == null ? '' : String(p[h]);
            return '"' + v.replace(/"/g, '""') + '"';
        }).join(','));
    });
    return rows.join('\n');
}

/* ════════════════════════════════════════════════════════════════
   PUBLIC API
   ════════════════════════════════════════════════════════════════ */
module.exports = {
    // Contact
    upsertContact          : upsertContact,
    getContactByCustomerNo : getContactByCustomerNo,
    updateContactMetrics   : updateContactMetrics,
    buildContactPayload    : buildContactPayload,

    // Lead
    upsertGuestLead        : upsertGuestLead,
    convertLeadToContact   : convertLeadToContact,

    // Opportunity / Purchase
    createOrderOpportunity  : createOrderOpportunity,
    computePurchaseBehaviour: computePurchaseBehaviour,

    // Batch
    bulkUpsertContacts : bulkUpsertContacts,
    getBulkJobStatus   : getBulkJobStatus,

    // Utilities (exported for testing)
    _formatDate        : formatDate,
    _escapeSOQL        : escapeSOQL,
    _getAccessToken    : getAccessToken
};
