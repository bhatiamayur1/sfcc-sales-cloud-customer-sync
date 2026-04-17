'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   SFCC → Salesforce Sales Cloud Customer Sync Accelerator       ║
 * ║   Controller: SalesCloudSync.js                                 ║
 * ║                                                                  ║
 * ║   Routes:                                                        ║
 * ║   GET  /SalesCloudSync-CustomerStatus   — sync status widget    ║
 * ║   POST /SalesCloudSync-TriggerSync      — manual resync         ║
 * ║   GET  /SalesCloudSync-SyncHealth       — ops dashboard data    ║
 * ║   POST /SalesCloudSync-SFWebhook        — inbound from SF       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

var server         = require('server');
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');
var userLoggedIn   = require('*/cartridge/scripts/middleware/userLoggedIn');
var SyncSvc        = require('*/cartridge/scripts/services/SalesCloudSyncService');
var Logger         = require('dw/system/Logger').getLogger('SalesCloudSync', 'SalesCloudSync');

/* ─────────────────────────────────────────────────────────────
   GET /SalesCloudSync-CustomerStatus
   Returns the current CRM profile data for the logged-in customer.
   Used by the "My Account → CRM Profile" widget.
   ───────────────────────────────────────────────────────────── */
server.get(
    'CustomerStatus',
    userLoggedIn.validateLoggedIn,
    function (req, res, next) {
        var profile    = req.currentCustomer.raw.profile;
        var customerNo = profile.customerNo;

        try {
            var sfContact = SyncSvc.getContactByCustomerNo(customerNo);

            res.json({
                success    : sfContact.ok,
                customerNo : customerNo,
                sfContactId: profile.custom.sfContactId || null,
                sfSyncStatus: profile.custom.sfSyncStatus || 'NOT_SYNCED',
                sfLastSynced: profile.custom.sfLastSyncedAt || null,
                crmData    : sfContact.ok ? {
                    lifetimeValue  : sfContact.data.sfcc_lifetime_value__c,
                    orderCount     : sfContact.data.sfcc_order_count__c,
                    lastOrderDate  : sfContact.data.sfcc_last_order_date__c
                } : null
            });
        } catch (e) {
            Logger.error('SalesCloudSync | CustomerStatus exception: {0}', e.message);
            res.json({ success: false, message: e.message });
        }

        return next();
    }
);

/* ─────────────────────────────────────────────────────────────
   POST /SalesCloudSync-TriggerSync
   Allows the customer to manually re-push their profile to CRM.
   Rate-limited to once per 24h via custom attribute.
   ───────────────────────────────────────────────────────────── */
server.post(
    'TriggerSync',
    userLoggedIn.validateLoggedIn,
    csrfProtection.validateAjaxRequest,
    function (req, res, next) {
        var Transaction = require('dw/system/Transaction');
        var profile     = req.currentCustomer.raw.profile;

        // Rate limit: 1 manual sync per 24h
        var lastSync = profile.custom.sfLastManualSyncAt;
        if (lastSync) {
            var hoursSince = (new Date() - new Date(lastSync)) / (1000 * 60 * 60);
            if (hoursSince < 24) {
                res.json({
                    success: false,
                    message: 'Manual sync is available once every 24 hours.',
                    nextAvailableIn: Math.ceil(24 - hoursSince) + ' hours'
                });
                return next();
            }
        }

        try {
            var result = SyncSvc.upsertContact(profile, {
                sfcc_manual_sync_at__c: new Date().toISOString()
            });

            if (result.ok) {
                Transaction.wrap(function () {
                    profile.custom.sfSyncStatus      = 'SYNCED';
                    profile.custom.sfLastSyncedAt    = new Date().toISOString();
                    profile.custom.sfLastManualSyncAt = new Date().toISOString();
                    profile.custom.sfSyncFailed      = false;
                });
                res.json({ success: true, message: 'Your profile has been synced to CRM.' });
            } else {
                res.json({ success: false, message: 'Sync failed. Please try again later.' });
            }
        } catch (e) {
            Logger.error('SalesCloudSync | TriggerSync exception: {0}', e.message);
            res.json({ success: false, message: e.message });
        }

        return next();
    }
);

/* ─────────────────────────────────────────────────────────────
   GET /SalesCloudSync-SyncHealth
   Ops dashboard: returns sync stats (failed, pending, last run).
   Secured by basic admin check.
   ───────────────────────────────────────────────────────────── */
server.get('SyncHealth', function (req, res, next) {
    var CustomerMgr = require('dw/customer/CustomerMgr');
    var Site        = require('dw/system/Site');

    // Simple admin key check (replace with proper admin middleware in production)
    var adminKey = req.httpHeaders.get('x-admin-key');
    var configKey = Site.getCurrent().getCustomPreferenceValue('scAdminKey') || '';
    if (!adminKey || adminKey !== configKey) {
        res.setStatusCode(401);
        res.json({ success: false, message: 'Unauthorised.' });
        return next();
    }

    try {
        var failedCount = CustomerMgr.queryProfiles(
            'customerNo != NULL AND custom.sfSyncFailed = true', null
        ).getCount();

        var syncedCount = CustomerMgr.queryProfiles(
            'customerNo != NULL AND custom.sfSyncStatus = {0}', null, 'SYNCED'
        ).getCount();

        var totalCount = CustomerMgr.queryProfiles(
            'customerNo != NULL', null
        ).getCount();

        res.json({
            success      : true,
            totalCustomers: totalCount,
            synced       : syncedCount,
            failed       : failedCount,
            syncRate     : totalCount > 0
                ? ((syncedCount / totalCount) * 100).toFixed(1) + '%' : '0%',
            timestamp    : new Date().toISOString()
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }

    return next();
});

/* ─────────────────────────────────────────────────────────────
   POST /SalesCloudSync-SFWebhook
   Inbound webhook from Salesforce (e.g. via Outbound Message or Flow)
   to push CRM data updates back to SFCC.
   Payload: { customerNo, sfContactId, updatedFields: { ... } }
   ───────────────────────────────────────────────────────────── */
server.post('SFWebhook', function (req, res, next) {
    var Site        = require('dw/system/Site');
    var Transaction = require('dw/system/Transaction');
    var secret      = Site.getCurrent().getCustomPreferenceValue('scWebhookSecret');
    var incoming    = req.httpHeaders.get('x-sf-webhook-secret');

    if (!secret || incoming !== secret) {
        Logger.warn('SalesCloudSync | Webhook rejected — bad secret');
        res.setStatusCode(401);
        res.json({ success: false });
        return next();
    }

    var payload;
    try { payload = JSON.parse(req.body); } catch (e) {
        res.setStatusCode(400);
        res.json({ success: false, message: 'Invalid JSON' });
        return next();
    }

    var customerNo = payload.customerNo;
    if (!customerNo) {
        res.setStatusCode(400);
        res.json({ success: false, message: 'customerNo required' });
        return next();
    }

    try {
        var CustomerMgr = require('dw/customer/CustomerMgr');
        var customer    = CustomerMgr.queryProfile('customerNo = {0}', customerNo);

        if (!customer) {
            res.setStatusCode(404);
            res.json({ success: false, message: 'SFCC customer not found: ' + customerNo });
            return next();
        }

        // Write CRM-sourced updates back to SFCC profile
        var updates = payload.updatedFields || {};
        Transaction.wrap(function () {
            if (updates.sfContactId)   customer.custom.sfContactId   = updates.sfContactId;
            if (updates.loyaltyTier)   customer.custom.loyaltyTier   = updates.loyaltyTier;
            if (updates.crmSegment)    customer.custom.crmSegment     = updates.crmSegment;
            customer.custom.sfLastSyncedAt   = new Date().toISOString();
            customer.custom.sfSyncStatus     = 'SYNCED';
        });

        Logger.info('SalesCloudSync | SF Webhook applied for customer: {0}', customerNo);
        res.json({ success: true });

    } catch (e) {
        Logger.error('SalesCloudSync | SFWebhook exception: {0}', e.message);
        res.setStatusCode(500);
        res.json({ success: false, message: e.message });
    }

    return next();
});

module.exports = server.exports();
