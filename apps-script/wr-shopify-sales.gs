/**
 * Wholesome Rabbit — Shopify SALES → ERP.  READ ONLY.
 * Renamed 2026-09-21 so it cannot be shadowed. READ THE NEXT PARAGRAPH.
 *
 * CLEANED 2026-09-21: the failure notice no longer sends mail. A rejected batch
 * is written to the Apps Script log instead, and the detail stays where it was
 * always most useful — shopify_events.post_error in Supabase. No Gmail scope.
 *
 * THIS IS WHY 103 OF 103 EVENTS WERE REJECTED WITH PGRST102.
 * Apps Script puts every file in one global scope. This project also holds
 * wr-shopify-inventory and wr-shopify-push, and BOTH of those define their own
 * sb_() — whose contract is the opposite of this file's:
 *
 *     inventory / push:   body is ALREADY a string   →  payload: opts.body
 *     this file:          body is an OBJECT          →  payload: JSON.stringify(opts.body)
 *
 * Whichever file loads last wins. When theirs won, this file handed an OBJECT
 * to a helper that passes it straight to UrlFetchApp — which form-encodes it as
 * `event_type=sale&shop_order_id=...`. PostgREST is told the body is JSON,
 * receives form data, and answers "Empty or invalid json". Every event, every
 * run. The error text in your log ("Supabase HTTP 400: ") is THEIR wording, not
 * this file's, which is how we know whose helper ran.
 *
 * So every name in this file is now prefixed ev… / EV_. Nothing here can be
 * shadowed by, or shadow, the other two scripts. The same three collisions were
 * also silently in play for DRY_RUN and runSelfTest — both were defined twice.
 *
 * STILL THE RIGHT THING TO DO EVENTUALLY: give each script its own Apps Script
 * project. The push script holds write_inventory and should not share a project
 * — or a token — with anything else.
 *
 * FIRST RUN, IN ORDER
 *   1. Delete the OLD sales file from this project (the one with pullShopify).
 *   2. evSelfTest()      — connections only, writes nothing.
 *   3. evDebugPost()     — posts one event and prints the body it sent.
 *   4. evPullShopify()   — the last 3 days.
 *   5. evBackfillShopify(35) — the 22 Aug → today gap, in a few requests.
 *   6. evInstallTriggers() — every 15 minutes from then on.
 *      (It removes any trigger still pointing at the old pullShopify.)
 */


var EV_DRY_RUN = false;          // ← leave true until you have read one clean log
var EV_LOOKBACK_DAYS = 3;        // re-reading is safe; the unique key absorbs it
var EV_API = '2024-10';
/* MUST name every column of a UNIQUE index on shopify_events — no more, no fewer.
   The table's index is shopify_events_uniq (event_type, shop_order_id, shop_line_id).
   Naming only two of its three columns is what produced 42P10 on every batch. */
var EV_KEY = 'shop_order_id,shop_line_id,event_type';
var EV_BATCH = 200;                                 // rows per request

/* ============================ plumbing ================================= */
function evCfg_(k, required) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  if (v) v = String(v).trim();                   // a pasted key often carries a newline
  if (required && !v) throw new Error('Missing Script Property: ' + k);
  return v;
}

/* JSON that is guaranteed to survive the trip: every character above 0x7E is
   written as a \uXXXX escape, so the body is pure ASCII and its byte length
   cannot disagree with its character length. */
function evJsonAscii_(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, function (c) {
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

function evSb_(path, opts) {
  opts = opts || {};
  var url = evCfg_('SUPABASE_URL', true).replace(/\/+$/, '') + '/rest/v1/' + path;
  var key = evCfg_('SUPABASE_KEY', true);
  var params = {
    method: opts.method || 'get',
    contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: opts.prefer || 'return=representation' },
    muteHttpExceptions: true,
    followRedirects: false          // a followed redirect re-sends as GET and drops the body
  };
  if (opts.body !== undefined && opts.body !== null) {
    var text = evJsonAscii_(opts.body);
    params.payload = Utilities.newBlob(text, 'application/json').getBytes();   // bytes, not a string
    if (opts.echo) Logger.log('BODY (%s bytes): %s', params.payload.length, text.slice(0, 300));
  }
  var res = UrlFetchApp.fetch(url, params);
  var code = res.getResponseCode(), out = res.getContentText();
  if (code >= 300) throw new Error('Supabase ' + code + ' on ' + path + ' — ' + out.slice(0, 400));
  return out ? JSON.parse(out) : null;
}

function evShopGet_(path) {
  var res = UrlFetchApp.fetch('https://' + evCfg_('SHOPIFY_SHOP', true) + '/admin/api/' + EV_API + '/' + path, {
    method: 'get',                                   // GET only. This script never writes to Shopify.
    headers: { 'X-Shopify-Access-Token': evCfg_('SHOPIFY_TOKEN', true) },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() === 429) { Utilities.sleep(2000); return evShopGet_(path); }
  if (res.getResponseCode() >= 300)
    throw new Error('Shopify ' + res.getResponseCode() + ' on ' + path + ' — ' + res.getContentText().slice(0, 400));
  return res;
}
function evNextPageInfo_(headers) {
  var link = headers['Link'] || headers['link'] || '';
  var m = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(link);
  return m ? decodeURIComponent(m[1]) : null;
}

/* ======================= 1 · the pull, once ============================ */
function evPullShopify() { return evPullSince_(EV_LOOKBACK_DAYS); }

/**
 * One-off historical load. The database still holds anything dated before the
 * sync start, so this is safe.   evBackfillShopify(35)
 */
function evBackfillShopify(days) { return evPullSince_(days || 30); }

function evPullSince_(days) {
  var since = new Date(Date.now() - days * 864e5).toISOString();
  var events = [], pageInfo = null, pages = 0;

  do {
    var path = pageInfo
      ? 'orders.json?limit=250&page_info=' + encodeURIComponent(pageInfo)
      : 'orders.json?status=any&limit=250&updated_at_min=' + encodeURIComponent(since);
    var res = evShopGet_(path);
    (JSON.parse(res.getContentText()).orders || []).forEach(function (o) { evCollectOrder_(o, events); });
    pageInfo = evNextPageInfo_(res.getAllHeaders());
    pages++;
  } while (pageInfo && pages < 40);

  Logger.log('Shopify: %s day(s) back · %s page(s) · %s event(s)', days, pages, events.length);
  if (!events.length) return 0;

  if (EV_DRY_RUN) {
    var n = { sale: 0, refund: 0, 'return': 0 };
    events.forEach(function (e) { n[e.event_type] = (n[e.event_type] || 0) + e.qty; });
    Logger.log('would send: %s sold · %s refunded · %s returned (packs)', n.sale || 0, n.refund || 0, n['return'] || 0);
    events.slice(0, 25).forEach(function (e) { Logger.log(evJsonAscii_(e)); });
    if (events.length > 25) Logger.log('… and %s more', events.length - 25);
    Logger.log('EV_DRY_RUN — nothing written. Run evCheckSkus() too, then set EV_DRY_RUN=false.');
    return events.length;
  }

  var r = evPostEvents_(events);
  Logger.log('posted %s · already had %s · rejected %s · %s request(s)', r.sent, r.dupes, r.failed, r.calls);
  Logger.log('Held and unmatched events are NOT failures — see Analytics → Shopify sync in the app.');
  evMirrorToSheet_(events);
  if (r.failed) Logger.log('REJECTED %s event(s) — check shopify_events.post_error in Supabase. First error: %s',
    r.failed, r.firstError || '(none captured)');
  return r.sent;
}

/**
 * A batch at a time, with the database skipping what it already has.
 * `resolution=ignore-duplicates` is what makes a batch survive the re-read the
 * lookback does on purpose — it was the reason this used to go one by one.
 */
function evPostEvents_(events) {
  var sent = 0, dupes = 0, failed = 0, calls = 0, firstError = '';
  for (var i = 0; i < events.length; i += EV_BATCH) {
    var slice = events.slice(i, i + EV_BATCH);
    try {
      /* return=representation hands back only the rows the database actually
         INSERTED, so the count in the log is the truth rather than the number
         of rows offered — the rest were already there. */
      var got = evSb_('shopify_events?on_conflict=' + encodeURIComponent(EV_KEY) + '&select=id', {
        method: 'post', body: slice, prefer: 'resolution=ignore-duplicates,return=representation'
      }) || [];
      calls++; sent += got.length; dupes += Math.max(0, slice.length - got.length);
    } catch (err) {
      calls++;
      var msg = String(err);
      if (!firstError) firstError = msg.slice(0, 400);

      /* 42P10 — "there is no unique or exclusion constraint matching the ON
         CONFLICT specification". The table is missing the unique index this
         key names, so the database cannot skip what it already has.
         STOP THE WHOLE RUN HERE. The old code fell back to plain INSERTs,
         and shopify_events fires a BEFORE INSERT trigger that posts a stock
         movement for every row — so a retry without ON CONFLICT does not
         "try again", it deducts the same packs a second time. Never insert
         into this table without the conflict clause. */
      if (msg.indexOf('42P10') >= 0 || /no unique or exclusion constraint/i.test(msg)) {
        throw new Error('ABORTED — no UNIQUE index on shopify_events matches (' + EV_KEY + '). '
          + 'EV_KEY must name EVERY column of the unique index, and only those columns; the order '
          + 'does not matter. Today that index is shopify_events_uniq '
          + '(event_type, shop_order_id, shop_line_id). Check it with: select pg_get_indexdef(indexrelid) '
          + 'from pg_index where indrelid = \'public.shopify_events\'::regclass and indisunique; '
          + 'Nothing further was written. Original error: ' + msg.slice(0, 200));
      }

      Logger.log('batch of %s refused (%s) — retrying one at a time', slice.length, msg.slice(0, 160));
      slice.forEach(function (e) {
        try {
          /* Still an UPSERT, one row at a time — so a row already in the table
             is skipped by the database, not inserted again. */
          var one = evSb_('shopify_events?on_conflict=' + encodeURIComponent(EV_KEY) + '&select=id', {
            method: 'post', body: [e], prefer: 'resolution=ignore-duplicates,return=representation'
          }) || [];
          if (one.length) sent++; else dupes++;
        }
        catch (err2) {
          if (String(err2).indexOf('23505') >= 0 || /duplicate key/i.test(String(err2))) dupes++;
          else { failed++; if (failed <= 10) Logger.log('FAILED %s %s — %s', e.event_type, e.shop_line_id, String(err2).slice(0, 200)); }
        }
        Utilities.sleep(60);
      });
    }
    Utilities.sleep(120);
  }
  return { sent: sent, dupes: dupes, failed: failed, calls: calls, firstError: firstError };
}

function evCollectOrder_(o, out) {
  var name = o.name || String(o.id);
  var when = o.processed_at || o.created_at;
  var customer = o.customer ? [o.customer.first_name, o.customer.last_name].filter(String).join(' ') : '';

  // SALES — one per line item. A cancelled order never sold anything.
  if (!o.cancelled_at) {
    (o.line_items || []).forEach(function (li) {
      if (!li.sku) return;                       // no SKU, nothing to match in the ERP
      if (!(+li.quantity > 0)) return;
      out.push({
        event_type: 'sale', shop_order_id: String(o.id), shop_line_id: String(li.id),
        order_name: name, occurred_at: when, variant_sku: li.sku, qty: +li.quantity,
        unit_price: +li.price || null, customer: customer, location_code: 'pasig',
        note: (li.title || '') + (li.variant_title ? ' · ' + li.variant_title : '')
      });
    });
  }

  /* REFUNDS AND RETURNS. Shopify calls both a "refund"; what tells them apart
     is restock_type. Only goods that came BACK to the shelf may go back into
     stock — a refund with no restock is money, not inventory. */
  (o.refunds || []).forEach(function (rf) {
    (rf.refund_line_items || []).forEach(function (rl) {
      var li = rl.line_item || {};
      if (!li.sku || !(+rl.quantity > 0)) return;
      if (rl.restock_type !== 'return' && rl.restock_type !== 'cancel') return;
      out.push({
        event_type: rl.restock_type === 'return' ? 'return' : 'refund',
        shop_order_id: String(o.id), shop_line_id: String(rl.id),
        order_name: name, occurred_at: rf.processed_at || rf.created_at || when,
        variant_sku: li.sku, qty: +rl.quantity, unit_price: +li.price || null,
        customer: customer, location_code: 'pasig',
        note: 'restock_type=' + rl.restock_type + (rf.note ? ' · ' + rf.note : '')
      });
    });
  });
}

/* ============ 2 · does every Shopify SKU exist in the ERP? ============= */
function evCheckSkus() {
  var shop = {}, pageInfo = null, pages = 0;
  do {
    var res = evShopGet_(pageInfo ? 'products.json?limit=250&page_info=' + encodeURIComponent(pageInfo)
                                : 'products.json?limit=250&status=active');
    (JSON.parse(res.getContentText()).products || []).forEach(function (p) {
      (p.variants || []).forEach(function (v) {
        if (v.sku) shop[v.sku] = p.title + (v.title && v.title !== 'Default Title' ? ' · ' + v.title : '');
      });
    });
    pageInfo = evNextPageInfo_(res.getAllHeaders());
    pages++;
  } while (pageInfo && pages < 40);

  /* wr_shopify_skus, NOT products. The publishable key runs as the anon role,
     which has no rights on products and should not be given any. */
  var erp = {};
  evSb_('wr_shopify_skus?select=sku,name').forEach(function (p) { erp[p.sku] = p.name; });
  var mapped = {};
  try { evSb_('shopify_sku_map?select=shop_sku,product_sku').forEach(function (m) { mapped[m.shop_sku] = m.product_sku; }); }
  catch (e) { Logger.log('(no shopify_sku_map yet — run PART 10 of the SQL)'); }

  var ok = [], missing = [];
  Object.keys(shop).forEach(function (s) {
    if (erp[s] || (mapped[s] && erp[mapped[s]])) ok.push(s); else missing.push(s + '   ' + shop[s]);
  });

  Logger.log('%s Shopify SKU(s) · %s match a product · %s do NOT', Object.keys(shop).length, ok.length, missing.length);
  if (missing.length) {
    Logger.log('THESE WILL NOT POST — add the product, or map it:');
    missing.slice(0, 60).forEach(function (m) { Logger.log('   ' + m); });
    Logger.log("Map one with:  insert into public.shopify_sku_map(shop_sku, product_sku) values ('SHOPIFY-CODE','ERP-CODE');");
  } else {
    Logger.log('✅ every Shopify SKU has a home in the ERP.');
  }
  var noShop = Object.keys(erp).filter(function (s) { return !shop[s] && s.indexOf('CUST-') !== 0; });
  Logger.log('%s ERP product(s) have no Shopify listing (normal for custom and wholesale).', noShop.length);
  return { matched: ok.length, unmatched: missing.length };
}

/* ========================= 3 · the paper trail ========================== */
function evMirrorToSheet_(events) {
  var id = evCfg_('SHEET_ID');
  if (!id || !events.length) return;
  try {
    var ss = SpreadsheetApp.openById(id);
    var sh = ss.getSheetByName('shopify_events') || ss.insertSheet('shopify_events');
    if (sh.getLastRow() === 0) sh.appendRow(['when', 'type', 'order', 'sku', 'qty', 'price', 'customer', 'note']);
    sh.getRange(sh.getLastRow() + 1, 1, events.length, 8).setValues(events.map(function (e) {
      return [e.occurred_at, e.event_type, e.order_name, e.variant_sku, e.qty, e.unit_price || '', e.customer || '', e.note || ''];
    }));
  } catch (err) { Logger.log('sheet mirror skipped — %s', String(err).slice(0, 160)); }
}

/* ===================== 4 · run these first ============================= */
function evSelfTest() {
  var bad = [];
  ['SUPABASE_URL', 'SUPABASE_KEY', 'SHOPIFY_SHOP', 'SHOPIFY_TOKEN'].forEach(function (k) { if (!evCfg_(k)) bad.push(k); });
  if (bad.length) { Logger.log('❌ missing Script Properties: %s', bad.join(', ')); return; }
  if (/service_role/.test(evCfg_('SUPABASE_KEY'))) Logger.log('⚠ that looks like a service_role key — use the PUBLISHABLE key');
  var u = evCfg_('SUPABASE_URL');
  if (/\/rest\/v1/.test(u)) Logger.log('⚠ SUPABASE_URL should stop at the project host — no /rest/v1');

  try { evSb_('shopify_events?select=id&limit=1'); Logger.log('✅ shopify_events is readable'); }
  catch (e) { Logger.log('❌ shopify_events — %s', evDenied_(e)); }

  try { Logger.log('✅ SKU list readable — %s product(s)', evSb_('wr_shopify_skus?select=sku').length); }
  catch (e) { Logger.log('❌ SKU list — %s', evDenied_(e)); }

  try { Logger.log('✅ Shopify OK — %s', JSON.parse(evShopGet_('shop.json').getContentText()).shop.name); }
  catch (e) { Logger.log('❌ Shopify failed — %s', String(e).slice(0, 240)); }

  Logger.log('Nothing was written, and nothing in this file can write to Shopify.');
  Logger.log('Next: evDebugPost(), then evCheckSkus(), then evPullShopify().');
}

/**
 * ONE event, with the body printed. If this logs "✅ accepted", the encoding
 * problem is gone and a full pull will work. If it still says PGRST102, copy
 * the BODY line out of the log — the fault is then in the row, not the wire.
 */
function evDebugPost() {
  var probe = {
    event_type: 'sale', shop_order_id: 'DEBUG', shop_line_id: 'DEBUG-' + Date.now(),
    order_name: '#DEBUG', occurred_at: new Date().toISOString(),
    variant_sku: 'DEBUG-SKU', qty: 1, unit_price: 1, customer: 'Encoding test · ñ é —',
    location_code: 'pasig', note: 'evDebugPost · non-ASCII on purpose'
  };
  try {
    evSb_('shopify_events', { method: 'post', body: probe, prefer: 'return=minimal', echo: true });
    Logger.log('✅ accepted — the JSON body is reaching PostgREST intact.');
    Logger.log('Tidy up when you are done:  delete from public.shopify_events where shop_order_id = \'DEBUG\';');
  } catch (e) {
    Logger.log('❌ still refused — %s', String(e).slice(0, 400));
    Logger.log('Copy the BODY line above. If that JSON is complete and valid, the row itself is the problem (an unknown column, or a check constraint), not the encoding.');
  }
}

function evDenied_(e) {
  var t = String(e);
  if (/42501|permission denied/.test(t))
    return 'permission denied — run PART 10 of the SQL. It grants exactly two things to anon: '
         + 'insert/select on shopify_events, and select on the wr_shopify_skus view. '
         + 'Do NOT grant on products, whatever the error message suggests.';
  return t.slice(0, 240);
}

/* ===================== 5 · install the schedule ======================== */
function evInstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    /* 'pullShopify' is the OLD name — a trigger still pointing at it would run
       the deleted file's handler and fail silently every 15 minutes. */
    if (['evPullShopify', 'pullShopify', 'pushShopify'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('evPullShopify').timeBased().everyMinutes(15).create();
  Logger.log('evPullShopify every 15 minutes. Nothing pushes to Shopify.');
}