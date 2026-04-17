# SFCC → Salesforce Sales Cloud Customer Sync Accelerator

> **CRM + Commerce integration: real-time customer data, purchase behaviour mapping, RFM intelligence.**

---

## Architecture

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                    CUSTOMER DATA FLOW                                        ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  SFCC STOREFRONT EVENTS          SFCC CARTRIDGE           SALESFORCE CRM     ║
║                                                                              ║
║  ┌─────────────────┐             ┌────────────────┐       ┌───────────────┐ ║
║  │ Customer        │─ created ──▶│ CustomerHooks  │──────▶│ Contact       │ ║
║  │ Registration    │             │                │  REST │ (upsert via   │ ║
║  └─────────────────┘             │ SalesCloudSync │  v59  │ external ID)  │ ║
║                                  │ Service.js     │       └───────┬───────┘ ║
║  ┌─────────────────┐             │                │               │         ║
║  │ Profile Update  │─ updated ──▶│ OAuth 2.0 CC   │       ┌───────▼───────┐ ║
║  └─────────────────┘             │ Token Cache    │       │ Contact       │ ║
║                                  │ (18-min TTL)   │       │ Trigger       │ ║
║  ┌─────────────────┐             └────────────────┘       │               │ ║
║  │ Customer Login  │─ login ────▶ patch last_login                │ RFM Score     │ ║
║  └─────────────────┘             + login_count             │ + Campaign    │ ║
║                                                            │   Member      │ ║
║  ┌─────────────────┐             ┌────────────────┐       └───────┬───────┘ ║
║  │ Email Opt-Out   │─ optOut ───▶│ PATCH          │               │         ║
║  └─────────────────┘             │ HasOptedOut=T  │       ┌───────▼───────┐ ║
║                                  └────────────────┘       │ LWC: Customer │ ║
║  ┌─────────────────┐             ┌────────────────┐       │ Insights Panel│ ║
║  │ Order Placed    │─ order ────▶│ Opportunity    │       │ (Contact page)│ ║
║  │ (registered)   │             │ + Line Items   │       └───────────────┘ ║
║  └─────────────────┘             │ Composite API  │                         ║
║                                  │ + Metrics      │  Webhook (push back)    ║
║  ┌─────────────────┐             └────────────────┘  ◀─────────────────── ║
║  │ Guest Checkout  │─ order ────▶ Lead upsert         loyalty tier, segment  ║
║  └─────────────────┘             + Opportunity                              ║
║                                                                              ║
║  ┌──────────────────────────────────────────────────────────────────────┐   ║
║  │  BATCH JOB (SalesCloudBatchSyncJob)                                  │   ║
║  │  FULL mode: Bulk v2 CSV → all customers                              │   ║
║  │  DELTA mode: REST upsert → customers modified in last N hours        │   ║
║  │  RETRY mode: re-attempt sfSyncFailed=true records                   │   ║
║  └──────────────────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

## What's Included

### SFCC Cartridge

| File | Purpose |
|---|---|
| `SalesCloudSyncService.js` | Core REST engine — OAuth2, Contact upsert/patch, Lead ops, Opportunity + line items, purchase behaviour compute, Bulk v2 |
| `SalesCloudCustomerHooks.js` | 5 lifecycle hooks: created, updated, login, opt-out, order placed |
| `SalesCloudBatchSyncJob.js` | 3-mode batch job: FULL (Bulk v2), DELTA (incremental), RETRY |
| `SalesCloudSync.js` | 4 controller routes: status widget, manual trigger, health check, SF webhook |
| `services.xml` | BM service + credential import |
| `CustomerSyncAttributes.xml` | SFCC Profile custom attributes |
| `hooks.json` | Hook registrations |

### Salesforce Org

| File | Purpose |
|---|---|
| `SFCCCustomerSyncHandler.cls` | RFM scoring model, Campaign assignment, push-to-SFCC callout, Lead dedup |
| `SFCCContactTrigger.trigger` | Contact trigger → score + notify on field changes |
| `customerInsightsPanel` (LWC) | Commerce insights panel on Contact record page |
| `SalesforceCustomFields.js` | Full custom field reference for all objects |

---

## Data Model

### Contact ← SFCC Registered Customer

```
Identity          sfcc_customer_no__c (External ID + Unique Index)
                  sfcc_site_id__c · sfcc_locale__c · sfcc_gender__c

Behaviour         sfcc_lifetime_value__c · sfcc_order_count__c
                  sfcc_avg_order_value__c · sfcc_last_order_date__c
                  sfcc_product_affinity__c (top 5 categories, ;-separated)
                  sfcc_high_value_customer__c

RFM Intelligence  sfcc_rfm_score__c  (e.g. "5-4-3")
                  sfcc_rfm_total__c  (3–15)
                  sfcc_rfm_segment__c → Champions | Loyal | At Risk | Lost …

Engagement        sfcc_login_count__c · sfcc_last_login__c
                  sfcc_newsletter_opt_in__c · HasOptedOutOfEmail

Loyalty           sfcc_loyalty_tier__c (written back from CRM via webhook)
```

### Lead ← SFCC Guest Checkout

```
sfcc_is_guest__c · sfcc_first_order_no__c
sfcc_first_order_total__c · sfcc_guest_order_at__c
→ Converts to Contact on customer registration
```

### Opportunity ← SFCC Order (1:1)

```
sfcc_order_no__c (External ID)
Amount · CurrencyIsoCode · CloseDate = order date
sfcc_subtotal__c · sfcc_tax_total__c · sfcc_shipping_total__c
OpportunityLineItems → 1 per SFCC ProductLineItem
```

---

## RFM Segmentation Model

| Segment | R | F | M | Recommended Action |
|---|---|---|---|---|
| Champions | 5 | 5 | 5 | Reward, ask for reviews |
| Loyal Customers | ≥4 | ≥4 | — | Upsell, loyalty programme |
| Recent Customers | 5 | ≤2 | — | Onboarding sequence |
| Potential Loyalists | ≥3 | — | ≥4 | Membership offer |
| Need Attention | — | — | — | Limited-time offer |
| At Risk | ≤2 | ≥4 | — | Win-back campaign |
| Lost | 1 | 1 | — | Re-engagement or archive |

Scores are recomputed by the `SFCCContactTrigger` on every purchase metrics update.

---

## Setup Guide

### Phase 1 — Salesforce Org

**1.1 Custom Fields**
Create all fields in `SalesforceCustomFields.js` on Contact, Lead, Opportunity, OpportunityLineItem, and Campaign via Setup → Object Manager.

**1.2 External IDs**
Mark `sfcc_customer_no__c` on Contact and `sfcc_order_no__c` on Opportunity as External IDs with Unique index — these drive upserts.

**1.3 Connected App**
Setup → App Manager → New Connected App → enable Client Credentials OAuth flow. Note Client ID + Secret.

**1.4 Deploy Apex**
```bash
sfdx auth:web:login -a MySFOrg
sfdx force:source:push -u MySFOrg
```
Deploy: `SFCCCustomerSyncHandler.cls`, `SFCCContactTrigger.trigger`

**1.5 Custom Metadata**
Create `SFCC_Integration_Config__mdt` record (`DeveloperName = Default`) with:
- `SFCC_Base_URL__c` → your storefront URL
- `Webhook_Secret__c` → shared secret (min 32 chars, random)

**1.6 Add LWC to Contact Page**
Lightning App Builder → Contact record page → drag `customerInsightsPanel` component → Activate.

**1.7 Campaign Setup** *(optional)*
Create Campaigns with `sfcc_target_segment__c` set to RFM segment names (e.g. "Champions", "At Risk") for automatic Campaign Member population.

---

### Phase 2 — SFCC

**2.1 Import Metadata**
```
BM → Administration → Operations → Import/Export
  Upload: services.xml

BM → Administration → Site Development → Import/Export
  Upload: CustomerSyncAttributes.xml
```

**2.2 Configure Services**
BM → Administration → Operations → Services:
- `salescloud.rest.auth.credentials` → set URL, Client ID, Client Secret
- `salescloud.rest.api.credentials` → set your SF org URL

**2.3 Install Cartridge**
Add `int_salescloud` to cartridge path. Hooks register automatically via `hooks.json`.

**2.4 Custom Site Preferences**
BM → Merchant Tools → Site Preferences → Custom Preferences:

| ID | Type | Value |
|---|---|---|
| `scSFAuthURL` | String | `https://login.salesforce.com/services/oauth2/token` |
| `scSFRestBaseURL` | String | `https://yourorg.my.salesforce.com` |
| `scSFAPIVersion` | String | `v59.0` |
| `scGuestCheckoutAsLead` | Boolean | `true` |
| `scHighValueCustomerThreshold` | Number | `1000` |
| `scWebhookSecret` | String | *(match SFCC_Integration_Config__mdt)* |
| `scAdminKey` | String | *(ops dashboard access key)* |

**2.5 Configure Batch Jobs**
BM → Administration → Operations → Jobs:

| Job | Mode | Schedule |
|---|---|---|
| SC Delta Sync | `DELTA`, deltaHours=1 | Every 30 min |
| SC Retry Sync | `RETRY`, maxRetries=5 | Every 2 hours |
| SC Full Sync | `FULL` | Weekly (off-peak) |

---

## API Reference

### SFCC Endpoints

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `GET` | `/SalesCloudSync-CustomerStatus` | Session | CRM data for My Account widget |
| `POST` | `/SalesCloudSync-TriggerSync` | Session + CSRF | Customer-triggered resync |
| `GET` | `/SalesCloudSync-SyncHealth` | x-admin-key header | Ops dashboard metrics |
| `POST` | `/SalesCloudSync-SFWebhook` | x-sf-webhook-secret | Inbound from Salesforce |

---

## Security Checklist

- [ ] SF Connected App credentials in BM Service config only — never in code
- [ ] `scWebhookSecret` is a cryptographically random string (≥32 chars)
- [ ] All customer-facing routes protected by session + CSRF middleware
- [ ] `filterLogMessage` strips Bearer tokens and client secrets from logs
- [ ] SFCC OCAPI scoped to minimum required permissions
- [ ] SF Connected App's Client Credentials profile restricted to integration user
- [ ] `SFCCContactTrigger` has test class with ≥90% coverage before deploying

---

## Extending the Accelerator

| Extension | Approach |
|---|---|
| **B2B Account sync** | Add `AccountId` lookup by company domain; link Contact to Account on upsert |
| **Einstein Lead Scoring** | Feed SFCC behaviour fields into Einstein Activity Capture |
| **Loyalty points** | Add `sfcc_loyalty_points__c` to Contact; increment after order; webhook back to SFCC |
| **Wishlist sync** | POST wishlist items to a custom `SFCC_Wishlist__c` child object of Contact |
| **Segment-triggered discount** | Apex Flow: when `sfcc_rfm_segment__c` = "At Risk" → POST coupon code to SFCC Customer API |
| **SFMC bridge** | Re-use Contact data to populate SFMC Data Extensions for email journeys |

---

## License

MIT — Reference implementation for CRM + Commerce integration patterns.
