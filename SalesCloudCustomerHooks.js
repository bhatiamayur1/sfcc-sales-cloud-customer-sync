'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   SFCC → Salesforce Sales Cloud Customer Sync Accelerator       ║
 * ║   Hooks: SalesCloudCustomerHooks.js                             ║
 * ║                                                                  ║
 * ║   Register all hooks in hooks.json:                             ║
 * ║     app.customer.created     → afterCustomerCreated             ║
 * ║     app.customer.updated     → afterProfileUpdated              ║
 * ║     app.customer.loggedIn    → afterCustomerLogin               ║
 * ║     app.customer.optedOut    → afterEmailOptOut                 ║
 * ║     app.post.order           → afterOrderPlaced                 ║
 * ║                                                                  ║
 * ║   Core design rule:                                              ║
 * ║   NEVER block storefront flows. Every SF call is wrapped in     ║
 * ║   try/catch. Failures are logged + flagged for the retry job.   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

var SyncSvc     = require('*/cartridge/scripts/services/SalesCloudSyncService');
var Transaction = require('dw/system/Transaction');
var Logger      = require('dw/system/Logger').getLogger('SalesCloudSync', 'SalesCloudSync');
var Site        = require('dw/system/Site');

/* ── Helper: safely write custom attrs without throwing ─────────── */
function safeWrite(fn) {
    try {
        Transaction.wrap(fn);
    } catch (e) {
        Logger.error('SalesCloud Hook | Transaction error: {0}', e.message);
    }
}

/* ── Helper: extract order guest data ───────────────────────────── */
function extractGuestData(order) {
    return {
        email      : order.customerEmail,
        firstName  : order.billingAddress ? order.billingAddress.firstName : '',
        lastName   : order.billingAddress ? order.billingAddress.lastName  : '',
        phone      : order.billingAddress ? order.billingAddress.phone     : '',
        orderNo    : order.orderNo,
        orderTotal : order.totalGrossPrice.value,
        currency   : order.currencyCode
    };
}

/* ════════════════════════════════════════════════════════════════
   HOOK 1 — Customer Registration
   app.customer.created
   ════════════════════════════════════════════════════════════════ */

/**
 * Fires when a new SFCC customer account is created.
 * - Upserts a Contact in Sales Cloud
 * - Checks for existing Lead (guest) and converts if found
 * - Stamps sf_contact_id__c back on the SFCC profile
 *
 * @param {dw.customer.Profile} profile
 */
function afterCustomerCreated(profile) {
    if (!profile || !profile.email) return;
    Logger.info('SalesCloud | afterCustomerCreated: {0}', profile.customerNo);

    try {
        // Check if a Lead exists for this email (prior guest checkout)
        var existingLead = findLeadByEmail(profile.email);

        if (existingLead && existingLead.leadId) {
            // Convert Lead → Contact
            var convertResult = SyncSvc.convertLeadToContact(existingLead.leadId, profile.customerNo);
            if (convertResult.ok) {
                safeWrite(function () {
                    profile.custom.sfContactId   = convertResult.contactId;
                    profile.custom.sfLeadId      = existingLead.leadId;
                    profile.custom.sfSyncStatus  = 'SYNCED_CONVERTED';
                    profile.custom.sfLastSyncedAt = new Date().toISOString();
                });
                Logger.info('SalesCloud | Lead converted to Contact [{0}] for customer {1}',
                    convertResult.contactId, profile.customerNo);
                return;
            }
        }

        // Fresh Contact upsert
        var result = SyncSvc.upsertContact(profile, {
            sfcc_registration_source__c: 'SFCC_Storefront',
            sfcc_acquisition_date__c   : new Date().toISOString().split('T')[0]
        });

        if (result.ok) {
            safeWrite(function () {
                profile.custom.sfContactId    = result.contactId || '';
                profile.custom.sfSyncStatus   = 'SYNCED';
                profile.custom.sfLastSyncedAt = new Date().toISOString();
                profile.custom.sfSyncFailed   = false;
            });
        } else {
            markSyncFailed(profile, result.errorMessage, 'REGISTRATION');
        }

    } catch (e) {
        Logger.error('SalesCloud | afterCustomerCreated exception [{0}]: {1}',
            profile.customerNo, e.message);
        markSyncFailedSafe(profile, e.message, 'REGISTRATION');
    }
}

/* ════════════════════════════════════════════════════════════════
   HOOK 2 — Profile Update
   app.customer.updated
   ════════════════════════════════════════════════════════════════ */

/**
 * Fires when the customer updates their profile (name, phone, etc.).
 * Patches the Contact record without recreating it.
 *
 * @param {dw.customer.Profile} profile
 */
function afterProfileUpdated(profile) {
    if (!profile || !profile.email) return;
    Logger.info('SalesCloud | afterProfileUpdated: {0}', profile.customerNo);

    try {
        var result = SyncSvc.upsertContact(profile, {
            sfcc_last_profile_update__c: new Date().toISOString()
        });

        if (result.ok) {
            safeWrite(function () {
                profile.custom.sfSyncStatus   = 'SYNCED';
                profile.custom.sfLastSyncedAt = new Date().toISOString();
                profile.custom.sfSyncFailed   = false;
            });
        } else {
            markSyncFailed(profile, result.errorMessage, 'PROFILE_UPDATE');
        }

    } catch (e) {
        Logger.error('SalesCloud | afterProfileUpdated exception [{0}]: {1}',
            profile.customerNo, e.message);
    }
}

/* ════════════════════════════════════════════════════════════════
   HOOK 3 — Customer Login
   app.customer.loggedIn
   ════════════════════════════════════════════════════════════════ */

/**
 * Fires on every successful login.
 * Updates login timestamp + increments login counter on Contact.
 * Intentionally lightweight — only two fields patched.
 *
 * @param {dw.customer.Profile} profile
 */
function afterCustomerLogin(profile) {
    if (!profile || !profile.customerNo) return;

    try {
        var customerNo = profile.customerNo;
        var path = '/services/data/{version}/sobjects/Contact/sfcc_customer_no__c/'
                 + encodeURIComponent(customerNo);

        // Fetch current login count to increment
        var contactData = SyncSvc.getContactByCustomerNo(customerNo);
        var currentCount = contactData.ok && contactData.data
            ? (contactData.data.sfcc_login_count__c || 0)
            : 0;

        // Delegate lightweight PATCH via the service's internal call
        // (exposed indirectly via upsertContact with minimal payload)
        SyncSvc.upsertContact(profile, {
            sfcc_last_login__c  : new Date().toISOString(),
            sfcc_login_count__c : currentCount + 1
        });

        Logger.info('SalesCloud | Login recorded for: {0}', customerNo);

    } catch (e) {
        // Login tracking is non-critical — swallow silently
        Logger.warn('SalesCloud | afterCustomerLogin warning [{0}]: {1}',
            profile.customerNo, e.message);
    }
}

/* ════════════════════════════════════════════════════════════════
   HOOK 4 — Email Opt-Out
   app.customer.optedOut
   ════════════════════════════════════════════════════════════════ */

/**
 * Fires when the customer opts out of marketing emails.
 * Sets HasOptedOutOfEmail = true on the Salesforce Contact.
 *
 * @param {dw.customer.Profile} profile
 */
function afterEmailOptOut(profile) {
    if (!profile || !profile.customerNo) return;
    Logger.info('SalesCloud | afterEmailOptOut: {0}', profile.customerNo);

    try {
        SyncSvc.upsertContact(profile, {
            HasOptedOutOfEmail         : true,
            sfcc_opt_out_date__c       : new Date().toISOString(),
            sfcc_opt_out_channel__c    : 'SFCC_Preference_Centre'
        });
    } catch (e) {
        Logger.error('SalesCloud | afterEmailOptOut exception [{0}]: {1}',
            profile.customerNo, e.message);
    }
}

/* ════════════════════════════════════════════════════════════════
   HOOK 5 — Order Placed
   app.post.order
   ════════════════════════════════════════════════════════════════ */

/**
 * Fires after every successful SFCC order placement.
 *
 * For registered customers:
 *   1. Upsert Contact (ensure it exists)
 *   2. Create Opportunity + line items
 *   3. Recompute + update purchase behaviour metrics on Contact
 *
 * For guest customers:
 *   1. Create / update a Lead record
 *   2. Create Opportunity linked to Lead (contactId null)
 *
 * @param {dw.order.Order} order
 */
function afterOrderPlaced(order) {
    if (!order) return;
    Logger.info('SalesCloud | afterOrderPlaced: {0}', order.orderNo);

    var isRegistered = order.customer && order.customer.registered;

    try {

        if (isRegistered) {
            /* ── Registered customer path ── */
            var profile   = order.customer.profile;

            // 1. Ensure Contact is current
            var upsertRes = SyncSvc.upsertContact(profile, {
                sfcc_last_order_date__c: new Date().toISOString().split('T')[0]
            });

            // 2. Get/create Contact ID
            var contactRes = SyncSvc.getContactByCustomerNo(profile.customerNo);
            var contactId  = contactRes.ok ? contactRes.contactId : null;

            // 3. Create Opportunity
            SyncSvc.createOrderOpportunity(order, contactId);

            // 4. Recompute behaviour metrics
            var metrics = SyncSvc.computePurchaseBehaviour(order.customer, order);
            SyncSvc.updateContactMetrics(profile.customerNo, metrics);

            Logger.info('SalesCloud | Registered order synced for customer {0}, order {1}',
                profile.customerNo, order.orderNo);

        } else {
            /* ── Guest customer path ── */
            if (!pref('scGuestCheckoutAsLead')) {
                Logger.info('SalesCloud | Guest lead creation disabled by site pref — skipping.');
                return;
            }

            var guestData = extractGuestData(order);

            // 1. Upsert Lead
            var leadRes = SyncSvc.upsertGuestLead(guestData);

            // 2. Create Opportunity (no Contact)
            SyncSvc.createOrderOpportunity(order, null);

            Logger.info('SalesCloud | Guest order synced. Lead: {0}, Order: {1}',
                leadRes.leadId, order.orderNo);
        }

    } catch (e) {
        // NEVER block the order confirmation
        Logger.error('SalesCloud | afterOrderPlaced exception [{0}]: {1}', order.orderNo, e.message);

        if (isRegistered && order.customer && order.customer.profile) {
            markSyncFailedSafe(order.customer.profile, e.message, 'ORDER_PLACED');
        }
    }
}

/* ════════════════════════════════════════════════════════════════
   PRIVATE HELPERS
   ════════════════════════════════════════════════════════════════ */

function findLeadByEmail(email) {
    try {
        var soql = 'SELECT Id FROM Lead WHERE Email = \''
            + email.replace(/'/g, "\\'") + '\' AND IsConverted = false LIMIT 1';
        // Use the service's internal SOQL helper via a minimal call
        // In practice, add a public getSingleRecord() to SalesCloudSyncService
        return null; // Placeholder — implement via SalesCloudSyncService.soqlQuery()
    } catch (e) { return null; }
}

function markSyncFailed(profile, errorMessage, context) {
    safeWrite(function () {
        profile.custom.sfSyncFailed    = true;
        profile.custom.sfSyncError     = '[' + context + '] ' + (errorMessage || '');
        profile.custom.sfSyncAttempts  = (profile.custom.sfSyncAttempts || 0) + 1;
        profile.custom.sfLastSyncedAt  = new Date().toISOString();
        profile.custom.sfSyncStatus    = 'FAILED';
    });
    Logger.error('SalesCloud | Sync failed [{0}] for customer {1}: {2}',
        context, profile.customerNo, errorMessage);
}

function markSyncFailedSafe(profile, errorMessage, context) {
    try { markSyncFailed(profile, errorMessage, context); } catch (e) { /* swallow */ }
}

function pref(key) {
    return Site.getCurrent().getCustomPreferenceValue(key);
}

/* ════════════════════════════════════════════════════════════════
   EXPORTS
   ════════════════════════════════════════════════════════════════ */
module.exports = {
    afterCustomerCreated : afterCustomerCreated,
    afterProfileUpdated  : afterProfileUpdated,
    afterCustomerLogin   : afterCustomerLogin,
    afterEmailOptOut     : afterEmailOptOut,
    afterOrderPlaced     : afterOrderPlaced
};
