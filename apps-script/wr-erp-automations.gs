/****************************************************************************************
 * Wholesome Rabbit ERP — Google Apps Script automations (replaces the n8n workflows; n8n retired 1 Nov 2026)
 * Backup aligned with the app's Download backup on 1 Nov 2026 (same tables, same _meta).
 * ----------------------------------------------------------------------------------
 * ONE web app handles all four app webhooks by routing on the payload shape:
 *   • Record Done  → build PDF → save to module Drive folder → link back → notify (TG + email)
 *   • Mention      → look up person in Supabase profiles → notify (TG + email)
 *   • File Upload  → decode base64 → save to Drive folder → share → write link to record
 *   • Demand Sync  → read the Google Sheet → replace demand rows in Supabase
 * Plus keepWarm() — a time-driven trigger that pings Supabase so the free project never sleeps.
 *
 * ============================ SETUP ============================
 * 1) Project Settings → Script properties → add the keys listed under SCRIPT PROPERTIES below.
 * 2) Triggers (clock icon) → Add Trigger → function: keepWarm, event: Time-driven, every 6 hours.
 * 3) Deploy → New deployment → type: Web app → Execute as: Me → Who has access: Anyone → Deploy.
 *    Copy the /exec URL.
 * 4) In the ERP: Administration → Automations → paste that SAME /exec URL into all four rows
 *    (Record→PDF, Mention, File upload, Google Sheets demand) and toggle each ON.
 *
 * ====================== SCRIPT PROPERTIES ======================
 *   WR_SERVICE_ROLE    (required) Supabase service_role key — server-side only, never in the app.
 *   TELEGRAM_BOT_TOKEN (required) Telegram bot token from @BotFather.
 *   TELEGRAM_CHAT_ID   (required) Default chat/group id for notifications (e.g. -5306350559).
 *   DEFAULT_EMAIL      (optional) Fallback email if a record carries none (e.g. you@domain.com).
 *   DEMAND_SHEET_ID    (required for demand sync) The Google Sheet document id.
 *   DEMAND_SHEET_TAB   (optional) Demand tab name — defaults to "Demand".
 ****************************************************************************************/

var SUPABASE_URL = 'https://nzormnscflumffbekwvz.supabase.co';   // public project URL (not secret)
var APP_URL      = 'https://mickomangalindan.github.io/WR-Inventory';

// Per-module Google Drive folders (PDFs + attachments land here). Adjust if you reorganise Drive.
var DRIVE_FOLDERS = {
  purchase_orders:   '1PrGcbHQ9suOR_bAUAFbQe0Ok23BJVFSd',
  goods_receipts:    'KwFpOOMVuruBLocSSQ5zUpDBF_iONJF3',
  production_batches:'1MDG9f-qsytaEIlMGvU1ZcNJf8B2cQhDR',
  transfers:         '1p2dW9HJ_wps6N0ztkxJe9eyzyQB5XP4I',
  count_sessions:    '1T0RkSXNVjVEVKpKu9WzFEzMWbxIcdCTL',
  supplier_invoices: '1jrqUYsdwrCaWXDgMBvTZIATJHuYicwgO',
  deliveries:        '13RAhv3yH1oIQLNMroPWTGIflLYdncY_A',
  mrp_plans:         '1RK_LaGEfUPBz7x6JatCGGlf9nOx8jZJX'
};
var DEFAULT_FOLDER = '16X3fhwSmWjJSuRS10mqOaTh2zmDZrNYb';

// Business-key column per model, so the Drive link can be PATCHed back onto the right row.
var PK_MAP = {
  purchase_orders:'po_ref', transfers:'transfer_ref', production_batches:'batch_ref',
  count_sessions:'count_ref', goods_receipts:'gr_ref', supplier_invoices:'invoice_ref', mrp_plans:'ref'
};

/* ------------------------------- helpers ------------------------------- */
function prop(k){ return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function ok(obj){ return ContentService.createTextOutput(JSON.stringify(obj||{ok:true})).setMimeType(ContentService.MimeType.JSON); }

function sbFetch(path, method, body){
  var key = prop('WR_SERVICE_ROLE');
  var opts = {
    method: method || 'get',
    muteHttpExceptions: true,
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Prefer': 'return=minimal' },
    contentType: 'application/json'
  };
  if (body !== undefined) opts.payload = (typeof body === 'string') ? body : JSON.stringify(body);
  return UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
}

function sendTelegram(chatId, text){
  var token = prop('TELEGRAM_BOT_TOKEN'); if (!token || !chatId) return;
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', muteHttpExceptions: true,
    payload: { chat_id: String(chatId), text: text, disable_web_page_preview: 'true' }
  });
}
function sendEmail(to, subject, body){
  if (!to) return;
  try { MailApp.sendEmail(to, subject, body); } catch (e) {}
}

/* ------------------------------- router ------------------------------- */
function doGet(){ return ok({ service: 'WR ERP automations', status: 'up' }); }

function doPost(e){
  try {
    var d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (d.action === 'sync_demand')           return handleDemandSync(d);
    if (d.data && d.filename)                  return handleFileUpload(d);
    if (Array.isArray(d.to))                   return handleMention(d);
    if (d.html)                                return handleRecordDone(d);
    return ok({ ok: false, reason: 'unrecognised payload' });
  } catch (err) {
    return ok({ ok: false, error: String(err) });
  }
}

/* ---------------------- 1) Record Done → PDF → notify ---------------------- */
function handleRecordDone(d){
  var ref = String(d.ref || 'Record');
  var kind = d.kind || 'Record';
  var model = d.model || d.module || '';
  var msg = 'Wholesome Rabbit — ' + kind + ' completed.\n\n' +
            'Internal Reference: ' + ref + '\n' +
            'Open in app: ' + APP_URL + '/#/' + model + '/' + encodeURIComponent(ref);

  // Notify first (so an alert always goes out even if Drive/PDF has a hiccup).
  sendTelegram(d.telegram_chat_id || prop('TELEGRAM_CHAT_ID'), msg);
  sendEmail(d.email || prop('DEFAULT_EMAIL'), 'WR — ' + kind + ' ' + ref, msg);

  // Build the PDF from the record HTML, save to the module folder, write the link back.
  try {
    var html = d.html || ('<h2>' + ref + '</h2><p>No content.</p>');
    var pdf = Utilities.newBlob(html, 'text/html', ref + '.html').getAs('application/pdf');
    pdf.setName(ref + '.pdf');
    var folderId = DRIVE_FOLDERS[model] || DEFAULT_FOLDER;
    var file = DriveApp.getFolderById(folderId).createFile(pdf);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var link = 'https://drive.google.com/file/d/' + file.getId() + '/view';
    var pk = PK_MAP[model] || 'id';
    sbFetch(model + '?' + pk + '=eq.' + encodeURIComponent(ref), 'patch', { drive_url: link });
  } catch (err) { /* notification already sent; PDF failure is non-fatal */ }

  return ok();
}

/* ---------------------- 2) Mention / Activity → notify ---------------------- */
function handleMention(d){
  var to = (d.to || []).filter(function(x){ return !!x; });
  var verb = (d.kind === 'activity') ? 'assigned you an activity' : 'mentioned you';
  for (var i = 0; i < to.length; i++) {
    var name = String(to[i]).trim();
    var email = '', chat = '';
    try {
      var res = sbFetch('profiles?name=eq.' + encodeURIComponent(name) + '&select=name,email,telegram_chat_id', 'get');
      var arr = JSON.parse(res.getContentText() || '[]');
      if (arr && arr[0]) { email = (arr[0].email || '').trim(); chat = (arr[0].telegram_chat_id || '').trim(); }
    } catch (err) {}
    if (!email && !chat) continue;  // no way to reach this person
    var hi = name ? ('Hi ' + name + ' — ') : '';
    var msg = hi + 'Wholesome Rabbit: ' + (d.author || 'Someone') + ' ' + verb + ' on ' + (d.module || d.model || '') + ' ' + (d.ref || '') + '.\n\n' +
              (d.body ? ('“' + d.body + '”\n\n') : '') +
              (d.due_at ? ('Due: ' + d.due_at + '\n') : '') +
              'Open: ' + (d.link || '');
    if (chat)  sendTelegram(chat, msg);
    if (email) sendEmail(email, 'WR — ' + (d.author || '') + ' ' + verb + (name ? (' (' + name + ')') : ''), msg);
  }
  return ok();
}

/* ---------------------- 3) File Upload → Drive → link back ---------------------- */
function handleFileUpload(d){
  var model = d.model || d.module || '';
  var ref = String(d.ref || '');
  try {
    var bytes = Utilities.base64Decode(d.data);
    var blob = Utilities.newBlob(bytes, d.mimetype || 'application/octet-stream', d.filename || 'upload');
    var folderId = DRIVE_FOLDERS[model] || DEFAULT_FOLDER;
    var file = DriveApp.getFolderById(folderId).createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var link = 'https://drive.google.com/file/d/' + file.getId() + '/view';
    sbFetch('record_attachments', 'post', {
      model: model, ref: ref, filename: d.filename || '', uploaded_by: d.by || '', drive_url: link
    });
  } catch (err) {}
  return ok();
}

/* ---------------------- 4) Demand Sync → Sheet → Supabase ---------------------- */
function handleDemandSync(d){
  var plan = d.plan_date || Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd');
  var sheetId = prop('DEMAND_SHEET_ID');
  var tab = prop('DEMAND_SHEET_TAB') || 'Demand';
  if (!sheetId) return ok({ ok: false, reason: 'DEMAND_SHEET_ID not set' });

  var values = SpreadsheetApp.openById(sheetId).getSheetByName(tab).getDataRange().getValues();
  if (!values || values.length < 2) return ok({ ok: true, count: 0 });
  var header = values[0].map(function(h){ return String(h).trim().toLowerCase(); });
  var skuIdx = firstIndex(header, ['sku', 'product sku', 'product_sku']);
  var qtyIdx = firstIndex(header, ['demand', 'qty', 'quantity', 'packs', 'units']);
  if (skuIdx < 0 || qtyIdx < 0) return ok({ ok: false, reason: 'SKU / qty column not found' });

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var sku = String(values[r][skuIdx] || '').trim();
    var qty = Number(values[r][qtyIdx] || 0);
    if (sku && qty > 0) rows.push({ sku: sku, qty: qty, plan_date: plan });
  }
  // Replace this plan-date's demand with the sheet's current numbers.
  sbFetch('demand?plan_date=eq.' + encodeURIComponent(plan), 'delete');
  if (rows.length) sbFetch('demand', 'post', rows);
  return ok({ ok: true, count: rows.length });
}
function firstIndex(header, names){
  for (var i = 0; i < header.length; i++) { if (names.indexOf(header[i]) >= 0) return i; }
  return -1;
}

/* ---------------------- 5) Keep-warm ping (time trigger) ----------------------
 * Supabase's free tier pauses a project after ~7 days with no DATABASE activity.
 * A plain SELECT is not always enough to reset that timer, so this WRITES a
 * heartbeat row every run (upsert into app_settings) — a real write reliably
 * counts as activity. The row also gives you a "last seen alive" timestamp.
 * Trigger: Add Trigger → keepWarm → Time-driven → every 6 hours (or daily).
 */
function keepWarm(){
  try {
    var payload = { key: 'keepwarm_last_ping', value: { at: new Date().toISOString(), by: 'keepWarm' } };
    // on_conflict=key + merge-duplicates → upsert the single heartbeat row (one real write).
    UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/app_settings?on_conflict=key', {
      method: 'post', muteHttpExceptions: true, contentType: 'application/json',
      headers: {
        'apikey': prop('WR_SERVICE_ROLE'),
        'Authorization': 'Bearer ' + prop('WR_SERVICE_ROLE'),
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(payload)
    });
  } catch (e) {}
}

/* ---------------------- 5b) Activity reminders (configurable + daily overdue) --------------
 * Telegram/email nudges for UNRESOLVED activities. For each activity it sends a reminder at
 * each configured "minutes before due" threshold (default 30 & 15), then — if enabled — a
 * once-a-day OVERDUE nudge (around a set hour) until the activity is marked done. Each nudge
 * fires at most once, tracked in record_notes.reminded. Requires wr_migration_activity_reminders.sql.
 *
 * CONFIG (edit in the app: Notifications → Reminder timing → saved to app_config.reminder_config):
 *   { "before":[30,15], "daily_overdue":true, "overdue_hour":8 }
 *   You can also override just the lead times with a Script Property WR_REMIND_MINUTES = "45,20,5".
 *
 * NOTE: an activity's due_at has no timezone, so it's read in the SCRIPT's timezone — set the
 * Apps Script project timezone to Asia/Manila (Project Settings) so the math matches the times
 * your team entered (and so the overdue hour is Manila time).
 *
 * Trigger: Add Trigger → remindActivities → Time-driven → Minutes timer → every 5 minutes.
 * (Run setupActivityReminders once to create it.)
 */
// Reminder timing config: app_config → reminder_config (edited in the app), with fallbacks.
function _reminderConfig(){
  var cfg = { before: [30, 15], daily_overdue: true, overdue_hour: 8, delivery_before: [1, 0], delivery_hour: 8 };
  try {
    var r = sbFetch('app_config?select=value&key=eq.reminder_config', 'get');
    var arr = JSON.parse(r.getContentText() || '[]');
    if (arr && arr[0] && arr[0].value) {
      var v = arr[0].value;
      if (Array.isArray(v.before) && v.before.length) cfg.before = v.before.map(Number).filter(function(x){ return x > 0; });
      if (typeof v.daily_overdue === 'boolean') cfg.daily_overdue = v.daily_overdue;
      if (v.overdue_hour != null) cfg.overdue_hour = Number(v.overdue_hour);
      // PO expected-delivery reminder timing: how many days BEFORE delivery to nudge (0 = on the day).
      if (Array.isArray(v.delivery_before) && v.delivery_before.length) cfg.delivery_before = v.delivery_before.map(Number).filter(function(x){ return x >= 0; });
      if (v.delivery_hour != null) cfg.delivery_hour = Number(v.delivery_hour);
    }
  } catch (e) {}
  // Script Property override for the lead times, e.g. WR_REMIND_MINUTES = "45,20,5"
  var p = prop('WR_REMIND_MINUTES');
  if (p) { var list = p.split(',').map(function(x){ return Number(x.trim()); }).filter(function(x){ return x > 0; }); if (list.length) cfg.before = list; }
  return cfg;
}

/* ---------------------------------------------------------------------------
 * Which table + primary key each note's `model` points at. Mirrors MODELS in
 * the app and wr_note_targets in the database. An unlisted model is treated as
 * "unknown, therefore still valid" so a new module never loses its reminders.
 * ------------------------------------------------------------------------- */
var NOTE_TARGETS = {
  suppliers:           { tbl: 'suppliers',           pk: 'name' },
  ingredients:         { tbl: 'ingredients',         pk: 'sku' },
  supplies:            { tbl: 'ingredients',         pk: 'sku' },
  products:            { tbl: 'products',            pk: 'sku' },
  purchase_orders:     { tbl: 'purchase_orders',     pk: 'po_ref' },
  production_batches:  { tbl: 'production_batches',  pk: 'batch_ref' },
  transfers:           { tbl: 'transfers',           pk: 'transfer_ref' },
  count_sessions:      { tbl: 'count_sessions',      pk: 'count_ref' },
  variance_log:        { tbl: 'variance_log',        pk: 'id' },
  inventory_movements: { tbl: 'inventory_movements', pk: 'id' }
};

/* Does the record a note hangs off still exist?
 * Returns true / false, or null when we genuinely cannot tell (unknown model,
 * network blip, non-200). Callers must treat null as "leave it alone" — never
 * silently resolve someone's activity because a request failed. */
function _parentExists(model, pk){
  var t = NOTE_TARGETS[model];
  if (!t || pk == null || pk === '') return null;
  var cacheKey = model + '�' + pk;
  _parentExists._c = _parentExists._c || {};
  if (_parentExists._c.hasOwnProperty(cacheKey)) return _parentExists._c[cacheKey];
  var out = null;
  try {
    var res = sbFetch(t.tbl + '?select=' + encodeURIComponent(t.pk) +
                      '&' + encodeURIComponent(t.pk) + '=eq.' + encodeURIComponent(pk) + '&limit=1', 'get');
    if (res.getResponseCode() < 300) {
      var arr = JSON.parse(res.getContentText() || '[]');
      out = (arr && arr.length > 0);
    }
  } catch (e) { out = null; }
  _parentExists._c[cacheKey] = out;
  return out;
}

/* Orphaned note → mark it resolved so it stops reminding, and leave a trace of why. */
function _resolveOrphan(a){
  try {
    sbFetch('record_notes?id=eq.' + encodeURIComponent(a.id), 'patch', {
      resolved: true,
      resolved_by: 'system (auto)',
      resolved_at: new Date().toISOString()
    });
  } catch (e) {}
}

function remindActivities(){
  var cfg = _reminderConfig();
  _parentExists._c = {};   // fresh per run — records get created and deleted between runs
  var beforeAsc = cfg.before.slice().sort(function(x, y){ return x - y; });
  var res;
  try { res = sbFetch('record_notes?select=id,model,record_pk,assignee,due_at,body,reminded&kind=eq.activity&resolved=eq.false&due_at=not.is.null&limit=500', 'get'); }
  catch (e) { return; }
  if (res.getResponseCode() >= 300) return;   // 400 here usually means the migration hasn't been run yet
  var acts = JSON.parse(res.getContentText() || '[]');
  var now = new Date();
  var nowMs = now.getTime();
  var tz = Session.getScriptTimeZone() || 'Asia/Manila';
  var todayTok = 'od-' + Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var curHour = Number(Utilities.formatDate(now, tz, 'H'));
  for (var i = 0; i < acts.length; i++) {
    var a = acts[i]; if (!a.due_at) continue;
    var due = new Date(String(a.due_at).replace(' ', 'T')).getTime();
    if (isNaN(due)) continue;
    var mins = (due - nowMs) / 60000;
    var marks = String(a.reminded || '').split(',').filter(Boolean);
    var has = function(t){ return marks.indexOf(t) >= 0; };
    var when = null, added = [];
    if (mins > 0) {
      // send the most urgent unsent "before" threshold; suppress any larger ones.
      for (var k = 0; k < beforeAsc.length; k++) {
        var T = beforeAsc[k];
        if (mins <= T && !has('b' + T)) { when = '~' + T + ' min'; cfg.before.forEach(function(x){ if (x >= T) added.push('b' + x); }); break; }
      }
    } else {
      // overdue: a once-per-day nudge, fired around the configured hour.
      if (cfg.daily_overdue && !has(todayTok) && curHour === cfg.overdue_hour) { when = 'overdue'; added.push(todayTok); }
    }
    if (!when) continue;
    // The record this activity hangs off may have been deleted (data wipe, cleanser).
    // Reminding about it forever is the phantom-notification bug — resolve instead.
    if (_parentExists(a.model, a.record_pk) === false) { _resolveOrphan(a); continue; }
    _remindOne(a, when);
    var newMarks = marks.concat(added.filter(function(t){ return marks.indexOf(t) < 0; }));
    try { sbFetch('record_notes?id=eq.' + encodeURIComponent(a.id), 'patch', { reminded: newMarks.join(',') }); } catch (e2) {}
  }
}

function _remindOne(a, when){
  var name = String(a.assignee || '').trim();
  var email = '', chat = '';
  if (name) {
    try {
      var r = sbFetch('profiles?name=eq.' + encodeURIComponent(name) + '&select=email,telegram_chat_id', 'get');
      var arr = JSON.parse(r.getContentText() || '[]');
      if (arr && arr[0]) { email = (arr[0].email || '').trim(); chat = (arr[0].telegram_chat_id || '').trim(); }
    } catch (e) {}
  }
  var head = (when === 'overdue') ? '🔴 OVERDUE' : ('⏰ Reminder — due in ' + when);
  var link = APP_URL + '/#/' + (a.model || '') + '/' + encodeURIComponent(a.record_pk || '');
  var msg = (name ? ('Hi ' + name + ' — ') : '') + head + ': “' + (a.body || 'activity') + '” on ' +
            (a.model || '') + ' ' + (a.record_pk || '') + '.\n' +
            'Due: ' + String(a.due_at).replace('T', ' ') + '\n' +
            'Open: ' + link + '\n\nMark it done in the app to stop reminders.';
  if (chat)  sendTelegram(chat, msg);
  if (email) sendEmail(email, 'WR reminder — ' + (a.body || 'activity'), msg);
  if (!chat && !email) sendTelegram(prop('TELEGRAM_CHAT_ID'), msg);   // fall back to the team chat if no personal contact set
}

function setupActivityReminders(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'remindActivities') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('remindActivities').timeBased().everyMinutes(5).create();
  Logger.log('Activity-reminder trigger created (every 5 minutes).');
}

/* ---------------------- 5b) PO expected-delivery reminders ----------------------
 * When a confirmed Purchase Order's expected_delivery approaches (default: 1 day before, and
 * on the day), the team chat + default email get a nudge. If the date passes while the PO is
 * still open (status confirmed, not received), a once-per-day "overdue delivery" nudge fires.
 * Fires at most once per PO per threshold, tracked in purchase_orders.delivery_reminded.
 * Requires wr_migration_po_expected_delivery.sql (adds expected_delivery + delivery_reminded).
 * SETUP: run setupDeliveryReminders() once (daily trigger). Timing is editable in the app
 * (Notifications → Reminder timing → delivery_before / delivery_hour in app_config.reminder_config).
 */
function remindDeliveries(){
  var cfg = _reminderConfig();
  var tz = Session.getScriptTimeZone() || 'Asia/Manila';
  var now = new Date();
  var curHour = Number(Utilities.formatDate(now, tz, 'H'));
  if (curHour !== cfg.delivery_hour) return;                 // once-a-day window at the configured hour
  var todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var today = new Date(todayStr + 'T00:00:00');
  var res;
  try { res = sbFetch('purchase_orders?select=po_ref,supplier_name,expected_delivery,status,delivery_reminded&status=eq.confirmed&expected_delivery=not.is.null&limit=1000', 'get'); }
  catch (e) { return; }
  if (res.getResponseCode() >= 300) return;                  // 400 usually means the migration hasn't been run yet
  var pos = JSON.parse(res.getContentText() || '[]');
  var beforeDesc = cfg.delivery_before.slice().sort(function(x, y){ return y - x; });   // largest lead first
  var chat = prop('TELEGRAM_CHAT_ID'), email = prop('DEFAULT_EMAIL');
  for (var i = 0; i < pos.length; i++) {
    var po = pos[i]; if (!po.expected_delivery) continue;
    var eta = new Date(String(po.expected_delivery).slice(0, 10) + 'T00:00:00');
    if (isNaN(eta.getTime())) continue;
    var days = Math.round((eta.getTime() - today.getTime()) / 86400000);   // whole days until delivery
    var marks = String(po.delivery_reminded || '').split(',').filter(Boolean);
    var has = function(t){ return marks.indexOf(t) >= 0; };
    var when = null, mark = null;
    if (days >= 0) {
      // fire the most urgent unsent "days before" threshold that we've reached today
      for (var k = 0; k < beforeDesc.length; k++) {
        var T = beforeDesc[k];
        if (days <= T && !has('d' + T)) { when = (T === 0 ? 'today' : ('in ' + days + ' day' + (days === 1 ? '' : 's'))); mark = 'd' + T; break; }
      }
    } else {
      var odTok = 'od-' + todayStr;
      if (!has(odTok)) { when = 'OVERDUE by ' + (-days) + ' day' + (days === -1 ? '' : 's'); mark = odTok; }
    }
    if (!when) continue;
    var head = (days < 0) ? '🔴 Delivery overdue' : '📦 Delivery reminder';
    var link = APP_URL + '/#/purchase_orders/' + encodeURIComponent(po.po_ref);
    var msg = head + ' — PO ' + po.po_ref + (po.supplier_name ? (' · ' + po.supplier_name) : '') + '\n' +
              'Expected delivery: ' + String(po.expected_delivery).slice(0, 10) + ' (' + when + ')\n' +
              'Open: ' + link + '\n\nReceive it in the app (batch receiving supported) to stop reminders.';
    if (chat) sendTelegram(chat, msg);
    if (email) sendEmail(email, 'WR — delivery ' + (days < 0 ? 'overdue' : 'due') + ': PO ' + po.po_ref, msg);
    var newMarks = marks.concat([mark]);
    try { sbFetch('purchase_orders?po_ref=eq.' + encodeURIComponent(po.po_ref), 'patch', { delivery_reminded: newMarks.join(',') }); } catch (e2) {}
  }
}

function setupDeliveryReminders(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'remindDeliveries') ScriptApp.deleteTrigger(t);
  });
  // Hourly so it can catch the configured delivery_hour regardless of project-timezone drift.
  ScriptApp.newTrigger('remindDeliveries').timeBased().everyHours(1).create();
  Logger.log('Delivery-reminder trigger created (hourly; fires at the configured delivery_hour).');
}

/* ---------------------- 6) Automated Supabase → Google Drive backup ----------------------
 * Dumps every table below to ONE JSON file in a Google Drive folder, on a schedule.
 * The file is the SAME shape the app's Administration → Data Cleanser → "Download backup"
 * makes, so you can restore any Drive backup straight back through the app's Restore box.
 *
 * SETUP
 *   1) (optional) Script properties → WR_BACKUP_FOLDER = a Drive folder ID to save into.
 *      Leave it unset and the script creates/uses a folder named "WR ERP Backups".
 *   2) (optional) WR_BACKUP_KEEP = how many backups to keep (default 30; older ones are trashed).
 *   3) (optional) WR_BACKUP_GZIP = "true" to also compress (saves a .json.gz; note: gz files must be
 *      un-gzipped before restoring in the app, so the plain .json is kept unless you set this).
 *   4) Run backupToDrive once from the editor to authorise Drive + verify the file lands.
 *   5) Run setupDailyBackup once → creates a daily time trigger (edit the hour/cadence inside).
 *   6) (optional) A short Telegram summary is sent if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set.
 */
// FULL database — every user table, parents → children (same list & order as the app's restore).
var BACKUP_TABLES = [
  'locations','suppliers','profiles','ingredients','products',
  'app_config','app_settings','ref_counters',
  'item_bins','item_suppliers','item_yields','item_group_options','bom_lines','raw_material_pricing','sales_momentum',
  'sales_orders','order_lines','custom_orders','custom_order_lines',
  'purchase_orders','po_lines','po_payments','goods_receipts','gr_lines','supplier_invoices','invoice_lines',
  'production_batches','batch_issues',
  'transfers','transfer_lines','count_sessions','count_lines',
  'deliveries','delivery_lines',
  'inventory_movements','variance_log','demand','mrp_plans','mrp_plan_lines',
  'saved_reports','record_notes','record_attachments','bulk_change_requests','activity_log',
  // The Shopify side — added 1 Nov 2026 so this file matches the app's download exactly
  // (BACKUP_TABLES in index.html). Restore skips shopify_events on purpose (it would re-post sales).
  'shopify_events','shopify_sku_map','shopify_inventory','shopify_products','shopify_push_queue'];

// Stable sort key per table so offset-paging can't skip or duplicate rows on big tables.
// Unlisted tables fall back to 'id'.
var BACKUP_PK = { locations:'code', suppliers:'name', ingredients:'sku', products:'sku', profiles:'id',
  app_config:'key', app_settings:'key', ref_counters:'key', sales_momentum:'sku',
  purchase_orders:'po_ref', goods_receipts:'gr_ref', supplier_invoices:'invoice_ref',
  production_batches:'batch_ref', transfers:'transfer_ref', count_sessions:'count_ref',
  sales_orders:'order_ref', deliveries:'delivery_ref', shopify_sku_map:'shop_sku' };

function _backupFolder(){
  var id = prop('WR_BACKUP_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  // fall back to a named folder at Drive root (create once, reuse after)
  var it = DriveApp.getFoldersByName('WR ERP Backups');
  if (it.hasNext()) return it.next();
  var f = DriveApp.createFolder('WR ERP Backups');
  Logger.log('Created backup folder "WR ERP Backups" (id ' + f.getId() + '). Optionally set WR_BACKUP_FOLDER to this id.');
  return f;
}

// Page through a table 1000 rows at a time (PostgREST caps a single response), ordered by its key.
function _fetchAll(table){
  var out = [], page = 1000, offset = 0, order = BACKUP_PK[table] || 'id';   // default order by id for stable paging
  while (true) {
    var path = table + '?select=*&limit=' + page + '&offset=' + offset + '&order=' + encodeURIComponent(order) + '.asc';
    var res = sbFetch(path, 'get');
    // If the table has no such order column (e.g. no id), retry unordered once.
    if (res.getResponseCode() >= 300 && offset === 0) { path = table + '?select=*&limit=' + page + '&offset=' + offset; res = sbFetch(path, 'get'); }
    if (res.getResponseCode() >= 300) throw new Error(table + ': HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 180));
    var rows = JSON.parse(res.getContentText() || '[]');
    out = out.concat(rows);
    if (rows.length < page) break;
    offset += page;
    if (offset > 2000000) break;   // hard safety stop
  }
  return out;
}

function backupToDrive(){
  // Same _meta as the app's Download backup (paged + per-table row counts), so the app's
  // Restore treats a Drive file exactly like a downloaded one.
  var dump = { _meta: { app: 'WR ERP', exported_by: 'backupToDrive (Apps Script)', source: 'backupToDrive (Apps Script)',
                        live: true, at: new Date().toISOString(), paged: true, rows: {}, short: [] } };
  var totalRows = 0, errs = [];
  for (var i = 0; i < BACKUP_TABLES.length; i++) {
    var t = BACKUP_TABLES[i];
    try { var rows = _fetchAll(t); dump[t] = rows; dump._meta.rows[t] = rows.length; totalRows += rows.length; }
    catch (e) { var m = String(e && e.message || e); dump[t] = { error: m }; dump._meta.short.push(t + ': ' + m); errs.push(t); }
  }
  dump._meta.total_rows = totalRows;
  dump._meta.tables = BACKUP_TABLES.length;

  var tz = Session.getScriptTimeZone() || 'Asia/Manila';
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd_HHmm');
  var name = 'wr-erp-backup-' + stamp + '.json';
  var folder = _backupFolder();
  var json = JSON.stringify(dump);
  var file = folder.createFile(name, json, 'application/json');
  if (String(prop('WR_BACKUP_GZIP')).toLowerCase() === 'true') {
    var gz = Utilities.gzip(Utilities.newBlob(json, 'application/json'), name + '.gz');
    folder.createFile(gz);
  }

  // Prune old backups — keep the most recent N (by name, which sorts by date).
  var keep = parseInt(prop('WR_BACKUP_KEEP') || '30', 10) || 30;
  _pruneBackups(folder, keep);

  var msg = '🗄️ WR ERP backup saved: ' + name + ' — ' + totalRows + ' rows across ' + BACKUP_TABLES.length + ' tables'
          + (errs.length ? (' · ⚠ failed: ' + errs.join(', ')) : '') + '. Folder: ' + folder.getName();
  Logger.log(msg + ' (file id ' + file.getId() + ')');
  try {
    var chat = prop('MICKO_TELEGRAM_CHAT_ID');
    if (chat) sendTelegram(chat, msg);
  } catch (e) {}
  return { file: name, rows: totalRows, errors: errs };
}

function _pruneBackups(folder, keep){
  var files = [];
  var it = folder.getFilesByType('application/json');
  while (it.hasNext()) { var f = it.next(); if (/^wr-erp-backup-.*\.json$/.test(f.getName())) files.push(f); }
  files.sort(function(a, b){ return b.getName().localeCompare(a.getName()); });   // newest first (name = date)
  for (var i = keep; i < files.length; i++) { try { files[i].setTrashed(true); } catch (e) {} }
}

// Run once to create a DAILY backup trigger (clears any prior one first). Edit atHour() to change the time.
function setupDailyBackup(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'backupToDrive') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupToDrive').timeBased().everyDays(1).atHour(2).create();   // ~2 AM project time
  Logger.log('Daily Drive-backup trigger created (runs ~02:00 ' + (Session.getScriptTimeZone() || '') + ').');
}
