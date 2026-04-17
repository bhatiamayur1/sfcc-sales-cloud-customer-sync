'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   SFCC → Salesforce Sales Cloud Customer Sync Accelerator       ║
 * ║   Job: SalesCloudBatchSyncJob.js                                ║
 * ║                                                                  ║
 * ║   Three execution modes (set via Job Parameter `mode`):         ║
 * ║                                                                  ║
 * ║   FULL   — initial load or periodic full refresh                ║
 * ║            Iterates ALL registered SFCC customers and upserts   ║
 * ║            to Sales Cloud using Bulk v2 API (CSV upload)        ║
 * ║                                                                  ║
 * ║   DELTA  — incremental sync (default, runs every 30 min)        ║
 * ║            Processes customers modified in the last N hours     ║
 * ║            via real-time REST upsert                            ║
 * ║                                                                  ║
 * ║   RETRY  — re-attempt records where sfSyncFailed = true         ║
 * ║            Clears flag on success, increments counter on fail   ║
 * ║                                                                  ║
 * ║   Job Parameters (Business Manager > Operations > Jobs):        ║
 * ║     mode          : FULL | DELTA | RETRY  (default: DELTA)     ║
 * ║     batchSize     : records per iteration (default: 100)        ║
 * ║     deltaHours    : lookback hours for DELTA (default: 1)       ║
 * ║     maxRetries    : skip records with attempts > N (default: 5) ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

var Status       = require('dw/system/Status');
var CustomerMgr  = require('dw/customer/CustomerMgr');
var Logger       = require('dw/system/Logger').getLogger('SalesCloudSync', 'SalesCloudSync');
var SyncSvc      = require('*/cartridge/scripts/services/SalesCloudSyncService');
var Transaction  = require('dw/system/Transaction');
var Calendar     = require('dw/util/Calendar');

/* ════════════════════════════════════════════════════════════════
   ENTRY POINT
   ════════════════════════════════════════════════════════════════ */

function execute(params) {
    var mode       = params.get('mode')       ? params.get('mode').toString().toUpperCase() : 'DELTA';
    var batchSize  = params.get('batchSize')  ? parseInt(params.get('batchSize'), 10) : 100;
    var deltaHours = params.get('deltaHours') ? parseInt(params.get('deltaHours'), 10) : 1;
    var maxRetries = params.get('maxRetries') ? parseInt(params.get('maxRetries'), 10) : 5;

    Logger.info('SalesCloud Sync Job | START — mode: {0}, batchSize: {1}', mode, batchSize);

    var stats = { processed: 0, synced: 0, failed: 0, skipped: 0 };

    try {
        switch (mode) {
            case 'FULL':
                runFullSync(batchSize, stats);
                break;
            case 'RETRY':
                runRetrySync(batchSize, maxRetries, stats);
                break;
            case 'DELTA':
            default:
                runDeltaSync(deltaHours, batchSize, stats);
                break;
        }
    } catch (e) {
        Logger.error('SalesCloud Sync Job | FATAL [{0}]: {1}', mode, e.message);
        return new Status(Status.ERROR, 'SC_SYNC_FATAL', e.message);
    }

    var summary = 'mode=' + mode + ' processed=' + stats.processed
        + ' synced=' + stats.synced + ' failed=' + stats.failed
        + ' skipped=' + stats.skipped;

    Logger.info('SalesCloud Sync Job | COMPLETE — {0}', summary);

    return stats.failed > 0
        ? new Status(Status.OK, 'SC_SYNC_PARTIAL', 'Partial sync. ' + stats.failed + ' failures.')
        : new Status(Status.OK, 'SC_SYNC_OK', summary);
}

/* ════════════════════════════════════════════════════════════════
   MODE: FULL  — Bulk v2 CSV upsert
   ════════════════════════════════════════════════════════════════ */

function runFullSync(batchSize, stats) {
    Logger.info('SalesCloud Sync Job | Running FULL sync via Bulk v2');

    var customerIter = CustomerMgr.queryProfiles('customerNo != NULL', 'customerNo asc');
    var batch        = [];

    while (customerIter.hasNext()) {
        var profile = customerIter.next();
        stats.processed++;

        try {
            var payload = SyncSvc.buildContactPayload(profile, {
                sfcc_registration_source__c: 'SFCC_BatchSync'
            });
            batch.push(payload);
        } catch (e) {
            stats.skipped++;
            Logger.warn('SalesCloud | Skipping {0}: {1}', profile.customerNo, e.message);
        }

        // Flush batch when full
        if (batch.length >= batchSize) {
            var flushResult = flushBatch(batch, stats);
            batch = [];
            if (!flushResult) break; // abort on fatal error
        }
    }

    // Flush remainder
    if (batch.length > 0) {
        flushBatch(batch, stats);
    }

    if (customerIter.close) customerIter.close();
}

function flushBatch(batch, stats) {
    try {
        var result = SyncSvc.bulkUpsertContacts(batch);
        if (result.ok) {
            stats.synced += batch.length;
            Logger.info('SalesCloud | Bulk batch queued: jobId={0} records={1}', result.jobId, batch.length);
        } else {
            stats.failed += batch.length;
            Logger.error('SalesCloud | Bulk batch failed: {0}', result.errorMessage);
        }
        return result.ok;
    } catch (e) {
        stats.failed += batch.length;
        Logger.error('SalesCloud | flushBatch exception: {0}', e.message);
        return false;
    }
}

/* ════════════════════════════════════════════════════════════════
   MODE: DELTA  — incremental REST upsert
   ════════════════════════════════════════════════════════════════ */

function runDeltaSync(deltaHours, batchSize, stats) {
    Logger.info('SalesCloud Sync Job | Running DELTA sync (last {0}h)', deltaHours);

    var cal = new Calendar();
    cal.add(Calendar.HOUR, -deltaHours);
    var threshold = cal.getTime();

    // Query profiles modified since threshold
    var customerIter = CustomerMgr.queryProfiles(
        'customerNo != NULL AND lastModified >= {0}',
        'lastModified asc',
        threshold
    );

    var count = 0;

    while (customerIter.hasNext() && count < batchSize) {
        var profile = customerIter.next();
        stats.processed++;
        count++;

        syncSingleProfile(profile, stats, {
            sfcc_delta_sync_at__c: new Date().toISOString()
        });
    }

    if (customerIter.close) customerIter.close();
}

/* ════════════════════════════════════════════════════════════════
   MODE: RETRY  — re-attempt failed syncs
   ════════════════════════════════════════════════════════════════ */

function runRetrySync(batchSize, maxRetries, stats) {
    Logger.info('SalesCloud Sync Job | Running RETRY sync');

    var customerIter = CustomerMgr.queryProfiles(
        'customerNo != NULL AND custom.sfSyncFailed = true AND custom.sfSyncAttempts < {0}',
        'custom.sfSyncAttempts asc',
        maxRetries
    );

    var count = 0;

    while (customerIter.hasNext() && count < batchSize) {
        var profile = customerIter.next();
        stats.processed++;
        count++;

        var result = syncSingleProfile(profile, stats, {
            sfcc_retry_sync_at__c: new Date().toISOString()
        });

        if (result) {
            // Clear failure flags on success
            try {
                Transaction.wrap(function () {
                    profile.custom.sfSyncFailed   = false;
                    profile.custom.sfSyncError    = '';
                    profile.custom.sfSyncStatus   = 'SYNCED';
                    profile.custom.sfLastSyncedAt = new Date().toISOString();
                });
            } catch (txErr) {
                Logger.warn('SalesCloud | Could not clear failure flag for {0}', profile.customerNo);
            }
        }
    }

    if (customerIter.close) customerIter.close();
}

/* ════════════════════════════════════════════════════════════════
   SHARED: sync a single profile via REST
   ════════════════════════════════════════════════════════════════ */

function syncSingleProfile(profile, stats, extras) {
    try {
        var result = SyncSvc.upsertContact(profile, extras);

        if (result.ok) {
            stats.synced++;
            try {
                Transaction.wrap(function () {
                    profile.custom.sfContactId    = result.contactId || profile.custom.sfContactId || '';
                    profile.custom.sfSyncStatus   = 'SYNCED';
                    profile.custom.sfLastSyncedAt = new Date().toISOString();
                    profile.custom.sfSyncFailed   = false;
                });
            } catch (txErr) { /* non-critical — log and continue */ }
            return true;
        }

        stats.failed++;
        try {
            Transaction.wrap(function () {
                profile.custom.sfSyncFailed   = true;
                profile.custom.sfSyncError    = result.errorMessage || '';
                profile.custom.sfSyncAttempts = (profile.custom.sfSyncAttempts || 0) + 1;
                profile.custom.sfSyncStatus   = 'FAILED';
            });
        } catch (txErr) { /* non-critical */ }
        return false;

    } catch (e) {
        stats.failed++;
        Logger.error('SalesCloud | syncSingleProfile exception [{0}]: {1}', profile.customerNo, e.message);
        return false;
    }
}

module.exports = { execute: execute };
