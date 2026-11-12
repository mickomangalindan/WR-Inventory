/****************************************************************************************
 * Wholesome Rabbit — ERP Telegram bot v2  (Apps Script · Claude API)            2026-11-12
 * ----------------------------------------------------------------------------------
 * Mention the bot in the team chat (or DM it). It reads the ERP, answers, works out
 * buying plans, sends Excel files, and CHANGES DATA — but every change is shown first
 * with ✅ Approve / ✖ Reject, and only Zeus or Micko can approve. Nothing changes until
 * an approver taps ✅. Every change is backed up in public.erp_bot_log (kind = change)
 * and written to activity_log.
 *
 * Long questions run in the background: the bot says "working on it" and posts the
 * answer when done (Apps Script stops any single run after 6 minutes, so heavy work
 * is continued on the next 1-minute tick).
 *
 * Money: the Claude API key must come from the Console organisation LINKED to your Max
 * plan, so it uses the plan's monthly API credit. Keep auto-reload OFF and no card on
 * that Console org: when the credit runs out the API simply stops — nothing is charged.
 * Your Max chat / Claude Code limits are not touched by the bot.
 *
 * PUT THIS IN ITS OWN APPS SCRIPT PROJECT (it replaces the v1 bot file completely).
 *
 * ============================== SCRIPT PROPERTIES ==============================
 *   TELEGRAM_BOT_TOKEN   from @BotFather
 *   BOT_USERNAME         the bot's @username without the @
 *   ANTHROPIC_API_KEY    from platform.claude.com (the org linked to your Max plan)
 *   WR_SERVICE_ROLE      Supabase service_role key
 *   OWNER_USER_ID        Zeus's Telegram user id (sees costs, /pause etc.)
 *   APPROVER_IDS         who may approve changes: Zeus's id,8310051733 (Micko)
 *   ALLOWED_CHAT_IDS     comma list of chats allowed to use the bot (groups are negative)
 *   (optional) MODEL          default claude-sonnet-5-5
 *   (optional) HEAVY_MODEL    default claude-opus-5-5 (big analyses; or start a question with /deep)
 *   (optional) DAILY_USD      default 3     — the bot pauses itself past it, and tells Zeus
 *   (optional) MONTHLY_USD    default 95    — same, per calendar month (Max 5x credit is $100)
 *   (optional) DAILY_LIMIT    questions per day for the whole team, default 80
 *   (optional) USER_HOURLY    questions per person per hour, default 15
 *   (optional) GITHUB_TOKEN / GITHUB_REPO  — Merge buttons for Claude's pull requests
 *
 * ================================== SETUP ======================================
 *   1) Replace the whole v1 file with this one. Add APPROVER_IDS. (MODEL replaces CLAUDE_MODEL.)
 *   2) Run installPolling() once and approve the new permissions (Sheets + Drive are
 *      needed to make the Excel files it sends).
 *   3) Run selfTest().
 *
 * In Telegram (Zeus): /pause /resume /usage /fixes /changes /prs · anyone: /help
 * Start a question with /deep to force the strongest model.
 ****************************************************************************************/

var SUPABASE_URL = 'https://nzormnscflumffbekwvz.supabase.co';
var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var MAX_TOOL_ROUNDS = 25;          // lookups per question
var RUN_BUDGET_MS = 270000;        // stop a run at 4.5 min and continue on the next tick
var MAX_OUT = 8000;

var READABLE = {
  products:1, ingredients:1, bom_lines:1, suppliers:1,
  custom_orders:1, custom_order_lines:1, production_batches:1, batch_issues:1,
  purchase_orders:1, po_lines:1, transfers:1, transfer_lines:1,
  count_sessions:1, count_lines:1, mrp_plans:1, demand:1,
  shopify_inventory:1, sales_momentum:1, shopify_events:1, variance_log:1,
  inventory_movements:1, stock_balance:1, erp_bot_log:1, activity_log:1, app_settings:1,
  wr_ingredient_reorder_v:1
};
var MUST_FILTER = { inventory_movements:1, shopify_events:1, batch_issues:1, count_lines:1, production_batches:1, activity_log:1 };
var MONEY_COL = /(cost|price|value|discount|fee|payment|_pct$|dp_pct|term_)/i;

/* USD per million tokens: in, out, cache read, cache write */
var PRICES = {
  'claude-haiku-5-5':  [0.10, 0.50, 0.01, 0.125],
  'claude-sonnet-5-5': [2.00, 10.00, 0.20, 2.50],
  'claude-opus-5-5':   [4.00, 20.00, 0.40, 5.00]
};

var PRIMER = [
'You are the Wholesome Rabbit ERP assistant in the team Telegram chat. Answer in plain everyday words (English or Tagalog, matching the asker). No jargon. Lead with the answer.',
'FORMAT FOR TELEGRAM: plain text. No ** markdown. Short lines; lists as "- ". For anything wider than 4 columns or longer than ~15 rows, call make_excel and give a short summary in the chat.',
'',
'WHAT YOU CAN DO',
'- READ: query (any listed table), search_code (the app code on GitHub), plot_need (works out the full buying picture for a demand plot).',
'- CHANGE: propose_change. It does NOT change anything by itself: it shows the exact change with Approve/Reject buttons and only Zeus or Micko can approve. Never say something is done until the approval message says so. Propose one change per call; you may propose several. Check the current values with query first and quote them in the reason.',
'- CODE FIXES to the app are not yours: use propose_fix; Claude builds and tests them in the Claude project.',
'- Every number you give must come from a tool result. If you could not check something, say so and say which screen to look at.',
'- A record saved BEFORE a fix shipped cannot prove the fix works (build date: search_code "WR_BUILD=").',
'',
'THE BUSINESS. Fresh / novel-protein dog food. bulacan = production kitchen (ERP is its stock record). pasig = sell site (Shopify is the stock record for finished packs at pasig; read shopify_inventory).',
'',
'KEY RULES',
'- Stock is a ledger: sum of inventory_movements (view stock_balance: location_code, kind, ref_sku, on_hand). Ingredients in grams; products in packs.',
'- Recipes: bom_lines (usable_g per pack). Ingredients raw or processed (is_intermediate, source_sku, yield_pct). Processed stock counts as raw: kg ÷ yield.',
'- INGREDIENT BUYING RULE (Zeus, 7 Nov 2026): delivery 7 days for every supplier; buffer 3 days of use. Reorder level = use per day × 10. Min buy = 1 week of use, never under 2 kg (whole kg; steps of 5 kg from 10 kg/week). Fill-up level = reorder + min buy. Order when (have + arriving − needed for the plot) < reorder; order = max(fill-up, needed + reorder) − (have + arriving), rounded up, at least min buy. Crocodile keeps no buffer (only what a plot needs). Use per week = wr_ingredient_reorder_v.rate_kg_wk. The plot_need tool does all of this.',
'- Plan ONE WEEK AHEAD: ingredients take 7 days to arrive, so a plot should be for the production week after next; this week\'s gaps must be bought locally.',
'- Regular Packs (finished packs) is separate: it works from Shopify sales and par; its settings live in each browser.',
'- Custom orders: custom_orders + custom_order_lines. Statuses: draft, for_production, in_demand, in_production, partial, completed, cancelled. A regular SKU on a custom order shows in the Custom section only; only production stamped with the order counts for it.',
'- Demand plots: mrp_plans (data.demand = packs per SKU, data.lines = ingredients to buy {sku,name,final grams,price,supplier}, data.locked). Newest locked plot = the week\'s target.',
'- POs: purchase_orders (open = not yet sent, rfq, quoted, confirmed, partial, received, cancelled) + po_lines (ordered_kg, received_kg). Only open/rfq/quoted POs may be edited; received ones never.',
'- Counts: count_sessions + count_lines. Bulacan finished packs are not counted weekly yet.',
'- variance_log is information only.',
'',
'TABLE COLUMNS',
'products: sku, name, variant, pack_g, status, active, is_custom, group_1, group_2',
'ingredients: sku, name, is_intermediate, source_sku, yield_pct, supplier, lead_time_days, reorder_g, par_g, min_order_kg, list_price_kg, active, notes',
'bom_lines: product_sku, ingredient_sku, usable_g',
'custom_orders: order_ref, customer_name, status, order_date, needed_date, delivery_date, notes · custom_order_lines: order_ref, product_sku, packs, written_off_packs',
'production_batches: batch_ref, product_sku, status, kind, good_packs, production_date, confirmed_at, order_ref',
'purchase_orders: po_ref, supplier_name, order_date, status, expected_delivery, received_at · po_lines: id, po_ref, ingredient_sku, ordered_kg, received_kg, price_kg',
'mrp_plans: id, plan_date, ref, saved_at, data · stock_balance: location_code, kind, ref_sku, on_hand',
'shopify_inventory: sku, location_name, available, on_hand, fetched_at · sales_momentum: sku, u30, u60, u90',
'inventory_movements: created_at, kind, ref_sku, location_code, qty, movement_type, note',
'wr_ingredient_reorder_v: sku, name, sup, lead_d, rate_kg_wk, reorder_kg, min_buy_kg, par_kg, price',
'',
'QUERY TIPS. PostgREST filters: status=eq.open, sku=in.(A,B), production_date=gte.2026-10-01, name=ilike.*duck*. Select only the columns you need. For JSON use select=data->demand.'
].join('\n');

/* ================================== plumbing ================================== */
function P(k){ return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function tg(method, payload){
  return UrlFetchApp.fetch('https://api.telegram.org/bot' + P('TELEGRAM_BOT_TOKEN') + '/' + method, {
    method:'post', contentType:'application/json', muteHttpExceptions:true, payload: JSON.stringify(payload) });
}
function send(chatId, text, extra){
  var chunks = String(text || '').match(/[\s\S]{1,3800}/g) || [''];
  chunks.forEach(function(c, i){
    var p = { chat_id: chatId, text: c, disable_web_page_preview: true };
    if (extra && i === chunks.length - 1) for (var k in extra) p[k] = extra[k];
    tg('sendMessage', p);
  });
}
function sendFile(chatId, blob, caption){
  UrlFetchApp.fetch('https://api.telegram.org/bot' + P('TELEGRAM_BOT_TOKEN') + '/sendDocument', {
    method:'post', muteHttpExceptions:true, payload:{ chat_id: String(chatId), caption: String(caption || '').slice(0, 1000), document: blob } });
}
function sb(method, path, body, prefer){
  var key = P('WR_SERVICE_ROLE');
  var o = { method: method, muteHttpExceptions:true, headers:{ apikey:key, Authorization:'Bearer ' + key } };
  if (prefer) o.headers.Prefer = prefer;
  if (body !== undefined) { o.contentType = 'application/json'; o.payload = JSON.stringify(body); }
  var r = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + path, o);
  var j = null; try { j = JSON.parse(r.getContentText()); } catch (e) {}
  return { code: r.getResponseCode(), text: r.getContentText(), json: j };
}
function sbGet(path){ return sb('get', path); }
function rows_(path){ var r = sbGet(path); if (r.code >= 300) throw new Error('read ' + path.split('?')[0] + ': HTTP ' + r.code + ' ' + r.text.slice(0, 200)); return r.json || []; }
function logRow(row){ var r = sb('post', 'erp_bot_log?select=id', row, 'return=representation'); return (r.json || [])[0] || null; }
function logPatch(id, fields){ sb('patch', 'erp_bot_log?id=eq.' + encodeURIComponent(id), fields, 'return=minimal'); }
function activity_(model, pk, event, who){
  sb('post', 'activity_log', { actor: 'erp-bot (approved by ' + who + ')', model: model, record_pk: pk, event: event }, 'return=minimal');
}
function approvers_(){ return (P('APPROVER_IDS') || P('OWNER_USER_ID')).split(',').map(function(s){ return s.trim(); }).filter(String); }
function enc(v){ return encodeURIComponent(String(v)); }

/* ================================ read tools ================================== */
var FILTER_RE = /^[a-z_][a-z0-9_]*(->>?[a-z0-9_]+)?=(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|in|is)\.[^&]{0,400}$/i;
function runQuery(input, isOwner){
  var t = String(input.table || '');
  if (!READABLE[t]) return { error: 'table not allowed: ' + t };
  var filters = (input.filters || []).map(String);
  for (var i = 0; i < filters.length; i++) if (!FILTER_RE.test(filters[i])) return { error: 'bad filter: ' + filters[i] };
  if (MUST_FILTER[t] && !filters.length) return { error: t + ' is large — add at least one filter' };
  var limit = Math.max(1, Math.min(500, +input.limit || 100));
  var sel = String(input.select || '*').replace(/[^a-zA-Z0-9_,*>\-]/g, '');
  var path = t + '?select=' + enc(sel) + (filters.length ? '&' + filters.map(function(f){
    var i = f.indexOf('='); return f.slice(0, i) + '=' + enc(f.slice(i + 1)); }).join('&') : '')
    + (input.order ? '&order=' + enc(String(input.order).replace(/[^a-z0-9_.,]/gi, '')) : '') + '&limit=' + limit;
  var r = sbGet(path);
  if (r.code >= 300) return { error: 'HTTP ' + r.code + ' ' + r.text.slice(0, 300) };
  var rows = r.json || [];
  if (!isOwner) rows = rows.map(function(o){ var c = {}; for (var k in o) if (!MONEY_COL.test(k)) c[k] = o[k]; return c; });
  var out = JSON.stringify(rows);
  if (out.length > 40000) out = out.slice(0, 40000) + ' …(cut — narrow the query)';
  return { rows: rows.length, data: out };
}

function searchCode_(input){
  var repo = P('GITHUB_REPO') || 'mickomangalindan/WR-Inventory';
  var file = String(input.file || 'index.html').replace(/[^A-Za-z0-9_./-]/g, '').replace(/\.\./g, '');
  var ctx = Math.max(0, Math.min(20, input.context == null ? 8 : +input.context));
  var r = UrlFetchApp.fetch('https://raw.githubusercontent.com/' + repo + '/main/' + file, { muteHttpExceptions:true });
  if (r.getResponseCode() >= 300) return { error: 'could not read ' + file + ' (HTTP ' + r.getResponseCode() + ')' };
  var lines = r.getContentText().split('\n'), re;
  try { re = new RegExp(String(input.pattern || ''), 'i'); } catch (e) { re = new RegExp(String(input.pattern || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  var hits = [];
  for (var i = 0; i < lines.length && hits.length < 10; i++) if (re.test(lines[i])) hits.push(i);
  if (!hits.length) return { matches: 0, note: 'no line matches ' + input.pattern };
  var out = [], used = {};
  hits.forEach(function(h){
    for (var k = Math.max(0, h - ctx); k <= Math.min(lines.length - 1, h + ctx); k++) {
      if (used[k]) continue; used[k] = 1; out.push((k + 1) + ': ' + lines[k].slice(0, 260)); }
    out.push('---');
  });
  var txt = out.join('\n'); if (txt.length > 14000) txt = txt.slice(0, 14000) + '\n…(cut)';
  return { file: file, matches: hits.length, code: txt };
}

/* ---- plot_need: the whole buying picture for a demand plot, worked out here ----
   Same rule as the 7 Nov reorder sheet: needed = packs × recipe g ÷ prep yield;
   have = raw + prepped-as-raw; arriving = sent POs (confirmed/partial) not yet in;
   drafts = open/rfq/quoted POs shown separately so nothing is ordered twice.       */
function plotNeed_(input){
  var ref = String(input.plot_ref || '');
  var plot = ref ? rows_('mrp_plans?select=ref,plan_date,saved_at,data&ref=eq.' + enc(ref))
                 : rows_('mrp_plans?select=ref,plan_date,saved_at,data&order=saved_at.desc&limit=10').filter(function(p){ return p.data && p.data.locked !== false; }).slice(0, 1);
  if (!plot.length) return { error: 'plot not found: ' + (ref || 'newest locked') };
  plot = plot[0]; var d = plot.data || {}; var demand = d.demand || {};
  var skus = Object.keys(demand).filter(function(s){ return +demand[s] > 0; });
  var closed = {};
  if (input.skip_closed_orders !== false) {
    var cust = skus.filter(function(s){ return /^CUST-/i.test(s); });
    if (cust.length) {
      var ls = rows_('custom_order_lines?select=order_ref,product_sku&product_sku=in.(' + cust.map(enc).join(',') + ')');
      var refs = {}; ls.forEach(function(l){ refs[l.order_ref] = 1; });
      var os = Object.keys(refs).length ? rows_('custom_orders?select=order_ref,status&order_ref=in.(' + Object.keys(refs).map(function(r){ return '"' + r + '"'; }).map(enc).join(',') + ')') : [];
      var open = {}; os.forEach(function(o){ if (!/completed|cancelled/.test(o.status)) open[o.order_ref] = 1; });
      cust.forEach(function(s){ if (!ls.some(function(l){ return l.product_sku === s && open[l.order_ref]; })) closed[s] = 1; });
    }
  }
  var bom = []; for (var i = 0; i < skus.length; i += 60)
    bom = bom.concat(rows_('bom_lines?select=product_sku,ingredient_sku,usable_g&product_sku=in.(' + skus.slice(i, i + 60).map(enc).join(',') + ')'));
  var ing = {}; rows_('ingredients?select=sku,name,is_intermediate,source_sku,yield_pct,supplier,supplier1,list_price_kg,reorder_g,par_g,min_order_kg,notes&limit=1000').forEach(function(x){ ing[x.sku] = x; });
  var rate = {}; rows_('wr_ingredient_reorder_v?select=sku,rate_kg_wk&limit=1000').forEach(function(x){ rate[x.sku] = +x.rate_kg_wk || 0; });
  var stock = {}; rows_('stock_balance?select=ref_sku,on_hand&location_code=eq.bulacan&kind=eq.ingredient&limit=2000').forEach(function(x){ stock[x.ref_sku] = +x.on_hand || 0; });
  var pos = rows_('purchase_orders?select=po_ref,status,supplier_name&status=in.(open,rfq,quoted,confirmed,partial)&limit=500');
  var arriving = {}, drafts = {}, draftRefs = {};
  if (pos.length) {
    var st = {}; pos.forEach(function(p){ st[p.po_ref] = p.status; });
    var refs2 = Object.keys(st);
    for (var j = 0; j < refs2.length; j += 40)
      rows_('po_lines?select=po_ref,ingredient_sku,ordered_kg,received_kg&po_ref=in.(' + refs2.slice(j, j + 40).map(function(r){ return enc('"' + r + '"'); }).join(',') + ')').forEach(function(l){
        var left = Math.max(0, (+l.ordered_kg || 0) - (+l.received_kg || 0)); if (!left) return;
        if (/confirmed|partial/.test(st[l.po_ref])) arriving[l.ingredient_sku] = (arriving[l.ingredient_sku] || 0) + left;
        else { drafts[l.ingredient_sku] = (drafts[l.ingredient_sku] || 0) + left; (draftRefs[l.ingredient_sku] = draftRefs[l.ingredient_sku] || []).push(l.po_ref); }
      });
  }
  var rawOf = function(s){ var x = ing[s] || {}; return (x.is_intermediate && x.source_sku) ? [x.source_sku, +x.yield_pct || 100] : [s, 100]; };
  var need = {};
  bom.forEach(function(b){
    if (closed[b.product_sku]) return;
    var q = +demand[b.product_sku] || 0, g = +b.usable_g || 0; if (!q || !g) return;
    var r = rawOf(b.ingredient_sku); need[r[0]] = (need[r[0]] || 0) + q * g / (r[1] / 100) / 1000;
  });
  var prepped = {};
  Object.keys(ing).forEach(function(s){ var x = ing[s]; if (x.is_intermediate && x.source_sku && stock[s] > 0) prepped[x.source_sku] = (prepped[x.source_sku] || 0) + stock[s] / ((+x.yield_pct || 100) / 100) / 1000; });
  var all = {}; [need, drafts, arriving].forEach(function(m){ for (var k in m) all[k] = 1; });
  Object.keys(rate).forEach(function(k){ if (rate[k] > 0) all[k] = 1; });
  var out = [];
  Object.keys(all).forEach(function(s){
    var x = ing[s]; if (!x || x.is_intermediate) return;
    var raw = Math.max(0, (stock[s] || 0) / 1000), pp = prepped[s] || 0, have = raw + pp, arr = arriving[s] || 0, nd = need[s] || 0;
    var rop = (+x.reorder_g || 0) / 1000, par = (+x.par_g || 0) / 1000, mb = +x.min_order_kg || 0, use = rate[s] || 0;
    var left = have + arr - nd, order = 0;
    if (left < 0 || left < rop) { var o = Math.max(par, nd + rop) - (have + arr); if (o > 0) order = Math.max(mb, Math.ceil(o)); }
    if (!nd && !order && !drafts[s]) return;
    out.push({ sku: s, name: x.name, supplier: x.supplier || x.supplier1 || '', use_kg_wk: r1(use), raw_kg: r1(raw), prepped_as_raw_kg: r1(pp),
      have_kg: r1(have), arriving_kg: r1(arr), needed_kg: r1(nd), short_this_week_kg: r1(Math.max(0, nd - have - arr)),
      cover_days: use > 0 ? Math.round(have / (use / 7)) : null, reorder_kg: r1(rop), fill_up_kg: r1(par), min_buy_kg: mb,
      order_kg: order, in_draft_pos_kg: r1(drafts[s] || 0), draft_pos: (draftRefs[s] || []).join(' '),
      still_to_order_kg: r1(Math.max(0, order - (drafts[s] || 0))), price_kg: +x.list_price_kg || 0 });
  });
  out.sort(function(a, b){ return a.name < b.name ? -1 : 1; });
  return { plot: plot.ref, plan_date: plot.plan_date, saved_at: plot.saved_at, skipped_closed_custom_skus: Object.keys(closed),
    rule: 'reorder = use/day×(7 delivery + 3 buffer); fill-up = reorder + min buy; order when have+arriving−needed < reorder',
    note: 'drafts (open POs) are NOT counted as arriving; still_to_order = order − drafts', rows: out };
}
function r1(n){ return Math.round((+n || 0) * 10) / 10; }

/* ---- make_excel: a real .xlsx sent into the chat ---- */
function makeExcel_(input, chatId){
  var title = String(input.title || 'WR ERP').slice(0, 80);
  var ss = SpreadsheetApp.create(title + ' ' + Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd HHmm'));
  try {
    (input.sheets || []).slice(0, 8).forEach(function(sh, i){
      var ws = i === 0 ? ss.getSheets()[0] : ss.insertSheet();
      ws.setName(String(sh.name || ('Sheet' + (i + 1))).slice(0, 90));
      var cols = (sh.columns || []).map(String), rows = (sh.rows || []).slice(0, 5000);
      var data = [cols].concat(rows.map(function(r){ return cols.map(function(_, k){ var v = Array.isArray(r) ? r[k] : r[cols[k]]; return v == null ? '' : v; }); }));
      if (cols.length) { ws.getRange(1, 1, data.length, cols.length).setValues(data); ws.getRange(1, 1, 1, cols.length).setFontWeight('bold').setBackground('#3b5a3a').setFontColor('#ffffff'); ws.setFrozenRows(1); }
      if (sh.note) ws.getRange(data.length + 2, 1).setValue(String(sh.note));
    });
    SpreadsheetApp.flush();
    var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
    var blob = UrlFetchApp.fetch(url, { headers:{ Authorization:'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob().setName(title.replace(/[^\w \-]/g, '') + '.xlsx');
    sendFile(chatId, blob, title);
    return { sent: true, file: blob.getName() };
  } catch (e) { return { error: 'could not build the file: ' + e.message }; }
  finally { try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (e) {} }
}

/* ============================ change actions =================================
 * The only things the bot can change. Each one: check() returns the current values
 * and a plain preview (or an error); run() makes the change after approval and
 * returns what it did. Both re-read live data — approval happens later, so run()
 * checks again that nothing moved in between.                                       */
var EDITABLE_PO = ['open', 'rfq', 'quoted'];
function poHead_(ref){ var h = rows_('purchase_orders?select=po_ref,status,supplier_name&po_ref=eq.' + enc(ref)); if (!h.length) throw new Error('PO not found: ' + ref); return h[0]; }
function nextPoRef_(){
  var dd = Utilities.formatDate(new Date(), 'Asia/Manila', 'MMddyyyy');
  var hs = rows_('purchase_orders?select=po_ref&po_ref=like.' + enc('PO-' + dd + '*'));
  var mx = 0; hs.forEach(function(h){ var m = /V(\d+)\./.exec(h.po_ref); if (m) mx = Math.max(mx, +m[1]); });
  return 'PO-' + dd + ' V' + ('0' + (mx + 1)).slice(-2) + '.01';
}
var ACTIONS = {
  po_set_qty: {
    help: 'Change the kg on one line of a not-yet-sent PO (0 removes the line). params: po_ref, ingredient_sku, kg',
    check: function(p){
      var h = poHead_(p.po_ref); if (EDITABLE_PO.indexOf(h.status) < 0) throw new Error(p.po_ref + ' is ' + h.status + ' — only open/rfq/quoted POs can be edited');
      var l = rows_('po_lines?select=id,ordered_kg,received_kg&po_ref=eq.' + enc(p.po_ref) + '&ingredient_sku=eq.' + enc(p.ingredient_sku));
      if (!l.length) throw new Error(p.ingredient_sku + ' is not on ' + p.po_ref + ' — use po_add_line');
      return { before: l[0], preview: p.po_ref + ' (' + h.supplier_name + '): ' + p.ingredient_sku + ' ' + l[0].ordered_kg + ' kg → ' + (+p.kg) + ' kg' + (+p.kg === 0 ? ' (line removed)' : '') };
    },
    run: function(p, c){
      return +p.kg === 0 ? sb('delete', 'po_lines?id=eq.' + c.before.id)
                         : sb('patch', 'po_lines?id=eq.' + c.before.id, { ordered_kg: +p.kg }, 'return=minimal');
    },
    model: 'purchase_orders', pk: function(p){ return p.po_ref; }
  },
  po_add_line: {
    help: 'Add an ingredient to a not-yet-sent PO. params: po_ref, ingredient_sku, kg, price_kg (optional — list price if left out)',
    check: function(p){
      var h = poHead_(p.po_ref); if (EDITABLE_PO.indexOf(h.status) < 0) throw new Error(p.po_ref + ' is ' + h.status);
      if (rows_('po_lines?select=id&po_ref=eq.' + enc(p.po_ref) + '&ingredient_sku=eq.' + enc(p.ingredient_sku)).length) throw new Error('already on the PO — use po_set_qty');
      var i = rows_('ingredients?select=sku,name,list_price_kg&sku=eq.' + enc(p.ingredient_sku)); if (!i.length) throw new Error('unknown ingredient ' + p.ingredient_sku);
      var price = p.price_kg != null ? +p.price_kg : (+i[0].list_price_kg || 0);
      return { price: price, preview: p.po_ref + ' (' + h.supplier_name + '): add ' + i[0].name + ' ' + (+p.kg) + ' kg' };
    },
    run: function(p, c){ return sb('post', 'po_lines', { po_ref: p.po_ref, ingredient_sku: p.ingredient_sku, ordered_kg: +p.kg, price_kg: c.price, received_kg: 0 }, 'return=minimal'); },
    model: 'purchase_orders', pk: function(p){ return p.po_ref; }
  },
  po_cancel: {
    help: 'Cancel a PO that has received nothing. params: po_ref',
    check: function(p){
      var h = poHead_(p.po_ref); if (/received|partial|cancelled/.test(h.status)) throw new Error(p.po_ref + ' is ' + h.status + ' — cannot cancel');
      return { before: h, preview: 'Cancel ' + p.po_ref + ' (' + h.supplier_name + ', now ' + h.status + ')' };
    },
    run: function(p){ return sb('patch', 'purchase_orders?po_ref=eq.' + enc(p.po_ref), { status: 'cancelled' }, 'return=minimal'); },
    model: 'purchase_orders', pk: function(p){ return p.po_ref; }
  },
  po_create: {
    help: 'Create a new draft PO (status open, not sent). params: supplier_name, lines: [{ingredient_sku, kg, price_kg?}]',
    check: function(p){
      if (!p.supplier_name || !(p.lines || []).length) throw new Error('supplier_name and lines are needed');
      var skus = p.lines.map(function(l){ return l.ingredient_sku; });
      var ii = {}; rows_('ingredients?select=sku,name,list_price_kg&sku=in.(' + skus.map(enc).join(',') + ')').forEach(function(x){ ii[x.sku] = x; });
      var bad = skus.filter(function(s){ return !ii[s]; }); if (bad.length) throw new Error('unknown: ' + bad.join(', '));
      var lines = p.lines.map(function(l){ return { ingredient_sku: l.ingredient_sku, ordered_kg: +l.kg, price_kg: l.price_kg != null ? +l.price_kg : (+ii[l.ingredient_sku].list_price_kg || 0), received_kg: 0 }; });
      return { lines: lines, preview: 'New draft PO for ' + p.supplier_name + ':\n' + lines.map(function(l){ return '- ' + ii[l.ingredient_sku].name + ' ' + l.ordered_kg + ' kg'; }).join('\n') };
    },
    run: function(p, c){
      var ref = nextPoRef_();
      var r = sb('post', 'purchase_orders', { po_ref: ref, supplier_name: p.supplier_name, order_date: Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd'), status: 'open', created_by: 'erp-bot' }, 'return=minimal');
      if (r.code >= 300) return r;
      var r2 = sb('post', 'po_lines', c.lines.map(function(l){ l.po_ref = ref; return l; }), 'return=minimal');
      r2.ref = ref; return r2;
    },
    model: 'purchase_orders', pk: function(p, res){ return (res && res.ref) || 'new PO'; }
  },
  order_set_status: {
    help: 'Set a custom order status (e.g. completed when delivered, cancelled). params: order_ref, status',
    check: function(p){
      var ok = ['draft','for_production','in_demand','in_production','partial','completed','cancelled'];
      if (ok.indexOf(p.status) < 0) throw new Error('status must be one of ' + ok.join(', '));
      var o = rows_('custom_orders?select=order_ref,customer_name,status&order_ref=eq.' + enc(p.order_ref)); if (!o.length) throw new Error('order not found');
      return { before: o[0], preview: p.order_ref + ' (' + o[0].customer_name + '): ' + o[0].status + ' → ' + p.status };
    },
    run: function(p){ return sb('patch', 'custom_orders?order_ref=eq.' + enc(p.order_ref), { status: p.status }, 'return=minimal'); },
    model: 'custom_orders', pk: function(p){ return p.order_ref; }
  },
  plot_set: {
    help: 'Change a demand plot: packs of a product (field demand) or kg of an ingredient to buy (field lines). params: plot_ref, field (demand|lines), sku, value (packs or kg; 0 removes)',
    check: function(p){
      var pl = rows_('mrp_plans?select=id,ref,data&ref=eq.' + enc(p.plot_ref)); if (!pl.length) throw new Error('plot not found');
      var d = pl[0].data || {}, old;
      if (p.field === 'demand') old = (d.demand || {})[p.sku];
      else if (p.field === 'lines') { var l = (d.lines || []).filter(function(x){ return x.sku === p.sku; })[0]; old = l ? l.final / 1000 : undefined; }
      else throw new Error('field must be demand or lines');
      return { id: pl[0].id, before: old, preview: p.plot_ref + ' ' + (p.field === 'demand' ? 'packs of ' : 'kg to buy of ') + p.sku + ': ' + (old == null ? 'none' : old) + ' → ' + (+p.value) };
    },
    run: function(p, c, who){
      var pl = rows_('mrp_plans?select=data&id=eq.' + c.id)[0]; var d = pl.data || {};
      if (p.field === 'demand') { d.demand = d.demand || {}; if (+p.value > 0) d.demand[p.sku] = +p.value; else delete d.demand[p.sku]; }
      else {
        d.lines = d.lines || []; var l = d.lines.filter(function(x){ return x.sku === p.sku; })[0];
        if (+p.value > 0) { if (l) l.final = +p.value * 1000; else {
          var i = rows_('ingredients?select=name,list_price_kg,supplier,supplier1&sku=eq.' + enc(p.sku))[0] || {};
          d.lines.push({ sku: p.sku, name: i.name || p.sku, final: +p.value * 1000, price: +i.list_price_kg || 0, supplier: i.supplier || i.supplier1 || '' }); } }
        else d.lines = d.lines.filter(function(x){ return x.sku !== p.sku; });
      }
      (d.bot_edits = d.bot_edits || []).push({ at: new Date().toISOString(), by: who, field: p.field, sku: p.sku, from: c.before, to: +p.value });
      return sb('patch', 'mrp_plans?id=eq.' + c.id, { data: d }, 'return=minimal');
    },
    model: 'mrp_plans', pk: function(p){ return p.plot_ref; }
  },
  stock_adjust: {
    help: 'Correct stock with a labelled adjustment. params: location (bulacan|pasig), kind (ingredient|product), sku, change (+ adds, − removes; kg for ingredients, packs for products), reason',
    check: function(p){
      if (!/^(bulacan|pasig|breeders)$/.test(p.location) || !/^(ingredient|product)$/.test(p.kind)) throw new Error('location or kind not allowed');
      if (!p.reason) throw new Error('a reason is required');
      var b = rows_('stock_balance?select=on_hand&location_code=eq.' + enc(p.location) + '&kind=eq.' + enc(p.kind) + '&ref_sku=eq.' + enc(p.sku));
      var now = b.length ? +b[0].on_hand : 0, unit = p.kind === 'ingredient' ? 'kg' : 'packs';
      var nowU = p.kind === 'ingredient' ? now / 1000 : now;
      return { before: now, preview: p.sku + ' at ' + p.location + ': ' + r1(nowU) + ' → ' + r1(nowU + (+p.change)) + ' ' + unit + ' (' + p.reason + ')' };
    },
    run: function(p, c, who){
      var qty = p.kind === 'ingredient' ? (+p.change) * 1000 : +p.change;
      return sb('post', 'inventory_movements', { kind: p.kind, ref_sku: p.sku, location_code: p.location, qty: qty, unit_cost: 0,
        movement_type: 'count_adjust', created_by: 'erp-bot (' + who + ')', note: 'Bot adjustment approved by ' + who + ': ' + p.reason }, 'return=minimal');
    },
    model: 'inventory_movements', pk: function(p){ return p.sku + '@' + p.location; }
  },
  ingredient_settings: {
    help: 'Change an ingredient\'s buying settings. params: sku, and any of lead_time_days, reorder_kg, fill_up_kg, min_buy_kg, notes',
    check: function(p){
      var i = rows_('ingredients?select=sku,name,lead_time_days,reorder_g,par_g,min_order_kg,notes&sku=eq.' + enc(p.sku)); if (!i.length) throw new Error('unknown ingredient');
      var x = i[0], ch = [];
      if (p.lead_time_days != null) ch.push('delivery ' + x.lead_time_days + ' → ' + p.lead_time_days + ' days');
      if (p.reorder_kg != null) ch.push('reorder ' + (+x.reorder_g / 1000) + ' → ' + p.reorder_kg + ' kg');
      if (p.fill_up_kg != null) ch.push('fill-up ' + (+x.par_g / 1000) + ' → ' + p.fill_up_kg + ' kg');
      if (p.min_buy_kg != null) ch.push('min buy ' + x.min_order_kg + ' → ' + p.min_buy_kg + ' kg');
      if (p.notes != null) ch.push('notes → "' + p.notes + '"');
      if (!ch.length) throw new Error('nothing to change');
      return { before: x, preview: x.name + ': ' + ch.join('; ') };
    },
    run: function(p){
      var f = {};
      if (p.lead_time_days != null) f.lead_time_days = +p.lead_time_days;
      if (p.reorder_kg != null) f.reorder_g = Math.round(+p.reorder_kg * 1000);
      if (p.fill_up_kg != null) f.par_g = Math.round(+p.fill_up_kg * 1000);
      if (p.min_buy_kg != null) f.min_order_kg = +p.min_buy_kg;
      if (p.notes != null) f.notes = String(p.notes);
      return sb('patch', 'ingredients?sku=eq.' + enc(p.sku), f, 'return=minimal');
    },
    model: 'ingredients', pk: function(p){ return p.sku; }
  }
};

var TOOLS = [
  { name:'query', description:'Read rows from one ERP table (read-only).',
    input_schema:{ type:'object', properties:{
      table:{ type:'string', description:'one of: ' + Object.keys(READABLE).join(', ') },
      select:{ type:'string' }, filters:{ type:'array', items:{ type:'string' } }, order:{ type:'string' }, limit:{ type:'integer' } }, required:['table'] } },
  { name:'search_code', description:'Search the ERP app code (index.html on GitHub, or apps-script/*.gs). Returns matching lines with context.',
    input_schema:{ type:'object', properties:{ pattern:{ type:'string' }, file:{ type:'string' }, context:{ type:'integer' } }, required:['pattern'] } },
  { name:'plot_need', description:'Work out the full buying picture for a demand plot: per ingredient the use per week, raw and prepped stock, arriving, needed for the plot, short this week, cover days, reorder, fill-up, min buy, order, what is already on draft POs and what is still to order. Use this for any buying / PO / shortage question.',
    input_schema:{ type:'object', properties:{ plot_ref:{ type:'string', description:'e.g. DP-11062026 [RAW] V01; empty = newest locked plot' },
      skip_closed_orders:{ type:'boolean', description:'default true: custom SKUs whose orders are all completed/cancelled count 0' } } } },
  { name:'make_excel', description:'Send an Excel file into the chat. Use for any table wider than 4 columns or longer than ~15 rows.',
    input_schema:{ type:'object', properties:{ title:{ type:'string' }, sheets:{ type:'array', items:{ type:'object', properties:{
      name:{ type:'string' }, columns:{ type:'array', items:{ type:'string' } }, rows:{ type:'array', items:{} }, note:{ type:'string' } } } } }, required:['title','sheets'] } },
  { name:'propose_change', description:'Propose ONE change to ERP data. Shown to the team with Approve/Reject; only Zeus or Micko can approve; nothing changes before that. Actions: ' +
      Object.keys(ACTIONS).map(function(k){ return k + ' — ' + ACTIONS[k].help; }).join(' | '),
    input_schema:{ type:'object', properties:{ action:{ type:'string', enum: Object.keys(ACTIONS) }, params:{ type:'object' }, reason:{ type:'string', description:'why, with the numbers you checked' } }, required:['action','params','reason'] } },
  { name:'propose_fix', description:'File an APP CODE fix for Claude to build (not for data changes — use propose_change for those).',
    input_schema:{ type:'object', properties:{ title:{ type:'string' }, problem:{ type:'string' }, evidence:{ type:'string' }, suggested_fix:{ type:'string' } }, required:['title','problem'] } }
];

/* ================================ Claude call ================================= */
function claude(model, messages, noTools){
  /* cache the growing conversation: one breakpoint on the newest user turn */
  messages.forEach(function(m){ if (Array.isArray(m.content)) m.content.forEach(function(b){ delete b.cache_control; }); });
  var lastU = messages[messages.length - 1];
  if (lastU && Array.isArray(lastU.content) && lastU.content.length) lastU.content[lastU.content.length - 1].cache_control = { type:'ephemeral' };
  var r = UrlFetchApp.fetch(ANTHROPIC_URL, { method:'post', muteHttpExceptions:true, contentType:'application/json',
    headers:{ 'x-api-key': P('ANTHROPIC_API_KEY'), 'anthropic-version':'2023-06-01' },
    payload: JSON.stringify({ model: model, max_tokens: MAX_OUT,
      system:[{ type:'text', text: PRIMER + '\nToday: ' + Utilities.formatDate(new Date(), 'Asia/Manila', 'EEE d MMM yyyy HH:mm') + ' (Manila).', cache_control:{ type:'ephemeral' } }],
      tools: TOOLS, tool_choice: noTools ? { type:'none' } : { type:'auto' }, messages: messages }) });
  var body = {}; try { body = JSON.parse(r.getContentText()); } catch (e) {}
  if (r.getResponseCode() >= 300) throw new Error('Claude API ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  return body;
}
function costOf(model, u){
  var p = PRICES[model] || PRICES['claude-sonnet-5-5'];
  return ((u.input_tokens||0)*p[0] + (u.output_tokens||0)*p[1] + (u.cache_read_input_tokens||0)*p[2] + (u.cache_creation_input_tokens||0)*p[3]) / 1e6;
}
function pickModel_(q){
  var heavy = /^\/deep\b/i.test(q) || q.length > 300 || /(compar|analy|review|optimi|forecast|excel|table|plan the|reorder|why does|audit)/i.test(q);
  return heavy ? (P('HEAVY_MODEL') || 'claude-opus-5-5') : (P('MODEL') || 'claude-sonnet-5-5');
}

/* ============================ the job (resumable) ============================ */
function startJob_(q, who, fromId, chatId, msgId, isOwner){
  var job = { q: q, who: who, fromId: fromId, chatId: chatId, msgId: msgId, isOwner: isOwner, model: pickModel_(q),
    round: 0, tot: { input_tokens:0, output_tokens:0, cache_read_input_tokens:0, cache_creation_input_tokens:0 },
    messages: [{ role:'user', content: [{ type:'text', text: 'Asked by ' + who + (isOwner ? ' (owner — may see costs)' : '') + ':\n' + q.replace(/^\/deep\s*/i, '') }] }],
    fixes: [], changes: [], told: false };
  var row = logRow({ kind:'question', chat_id: chatId, asked_by: who, asked_by_id: fromId, question: q, status:'working', model: job.model, job: job });
  job.id = row && row.id;
  return job;
}
function saveJob_(job){ if (job.id) logPatch(job.id, { job: job }); }

/* Runs until done or the time budget is used. Returns true when finished. */
function runJob_(job, deadline){
  while (job.round <= MAX_TOOL_ROUNDS) {
    if (Date.now() > deadline) {
      if (!job.told) { send(job.chatId, '⏳ Working on it — this one takes a few minutes. I\'ll post the answer here.', { reply_to_message_id: job.msgId }); job.told = true; }
      saveJob_(job); return false;
    }
    var last = job.round === MAX_TOOL_ROUNDS;
    if (last) {
      var nudge = { type:'text', text:'You have used all your lookups. Answer now from what you found and say what you could not check.' };
      var prev = job.messages[job.messages.length - 1];
      if (prev.role === 'user') prev.content.push(nudge); else job.messages.push({ role:'user', content:[nudge] });
    }
    var res = claude(job.model, job.messages, last);
    var u = res.usage || {}; for (var k in job.tot) job.tot[k] += (u[k] || 0);
    var content = res.content || [];
    job.round++;
    if (res.stop_reason !== 'tool_use' || last) {
      job.text = content.filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('\n').trim();
      if (!job.text) job.text = 'I could not finish this one. Try asking it in smaller parts, or start with /deep.';
      finishJob_(job); return true;
    }
    job.messages.push({ role:'assistant', content: content });
    var results = [];
    content.forEach(function(b){
      if (b.type !== 'tool_use') return;
      var out;
      try {
        if (b.name === 'query') out = runQuery(b.input || {}, job.isOwner);
        else if (b.name === 'search_code') out = searchCode_(b.input || {});
        else if (b.name === 'plot_need') out = plotNeed_(b.input || {});
        else if (b.name === 'make_excel') out = makeExcel_(b.input || {}, job.chatId);
        else if (b.name === 'propose_change') out = proposeChange_(b.input || {}, job);
        else if (b.name === 'propose_fix') { job.fixes.push(b.input || {}); out = { filed: true }; }
        else out = { error: 'unknown tool' };
      } catch (e) { out = { error: String(e.message || e).slice(0, 400) }; }
      var s = JSON.stringify(out); if (s.length > 60000) s = s.slice(0, 60000) + '…(cut)';
      results.push({ type:'tool_result', tool_use_id: b.id, content: s });
    });
    job.messages.push({ role:'user', content: results });
    saveJob_(job);
  }
  return true;
}
function finishJob_(job){
  var cost = costOf(job.model, job.tot), props = PropertiesService.getScriptProperties();
  ['USD' + day_(), 'USDM' + month_()].forEach(function(k){ props.setProperty(k, String((+(props.getProperty(k) || 0)) + cost)); });
  send(job.chatId, job.text + (job.isOwner ? '\n\n— ' + job.model + ' · $' + cost.toFixed(3) : ''), { reply_to_message_id: job.msgId });
  if (job.id) logPatch(job.id, { status: 'done', answer: job.text, job: null, model: job.model,
    tokens_in: job.tot.input_tokens + job.tot.cache_read_input_tokens + job.tot.cache_creation_input_tokens, tokens_out: job.tot.output_tokens, cost_usd: Math.round(cost * 1e5) / 1e5 });
  job.fixes.forEach(function(f){
    var detail = 'Problem: ' + (f.problem || '') + '\nEvidence: ' + (f.evidence || '') + '\nSuggested fix: ' + (f.suggested_fix || '(none)') + '\nFrom ' + job.who + ': ' + job.q;
    var row = logRow({ kind:'fix', chat_id: job.chatId, asked_by: job.who, asked_by_id: job.fromId, question: job.q, fix_title: f.title || 'Fix', fix_detail: detail, status:'pending', model: job.model });
    var owner = P('OWNER_USER_ID');
    if (owner && row && row.id) send(owner, '🛠 App fix #' + row.id + ' — ' + (f.title || '') + '\n\n' + detail, {
      reply_markup: { inline_keyboard: [[ { text:'✅ Approve', callback_data:'ok:' + row.id }, { text:'❌ Reject', callback_data:'no:' + row.id } ]] } });
  });
}
function day_(){ return Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyyMMdd'); }
function month_(){ return Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyyMM'); }

/* ---- a proposed change: checked now, shown with buttons, run only on approval ---- */
function proposeChange_(input, job){
  var a = ACTIONS[input.action]; if (!a) return { error: 'unknown action' };
  var c; try { c = a.check(input.params || {}); } catch (e) { return { error: 'not proposed: ' + e.message }; }
  var row = logRow({ kind:'change', chat_id: job.chatId, asked_by: job.who, asked_by_id: job.fromId, question: job.q,
    fix_title: input.action, fix_detail: c.preview + '\nWhy: ' + (input.reason || ''), status:'pending', model: job.model,
    action: { action: input.action, params: input.params || {}, before: c.before == null ? null : c.before } });
  if (!row || !row.id) return { error: 'could not file the change' };
  send(job.chatId, '✏️ Change #' + row.id + ' (needs Zeus or Micko)\n' + c.preview + '\nWhy: ' + (input.reason || ''), {
    reply_markup: { inline_keyboard: [[ { text:'✅ Approve', callback_data:'ca:' + row.id }, { text:'✖ Reject', callback_data:'cr:' + row.id } ]] } });
  return { proposed: true, change_id: row.id, preview: c.preview, note: 'Waiting for approval — not done yet.' };
}
function decideChange_(cb, id, approve){
  var who = [cb.from.first_name, cb.from.last_name].filter(String).join(' ') || String(cb.from.id);
  var row = (rows_('erp_bot_log?select=id,status,action,fix_detail&id=eq.' + id) || [])[0];
  var clear = function(){ tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }); };
  if (!row || row.status !== 'pending') { tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already decided.' }); clear(); return; }
  if (!approve) {
    logPatch(id, { status:'rejected', decided_by: who, decided_at: new Date().toISOString() });
    tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Rejected' }); clear();
    return send(cb.message.chat.id, '✖ Change #' + id + ' rejected by ' + who + '. Nothing was changed.');
  }
  var act = ACTIONS[row.action.action], p = row.action.params || {}, msg;
  try {
    var c = act.check(p);                                   // re-check: data may have moved since it was proposed
    if (row.action.before != null && JSON.stringify(c.before) !== JSON.stringify(row.action.before))
      throw new Error('the data changed since this was proposed (now: ' + c.preview + '). Ask again.');
    var r = act.run(p, c, who);
    if (r && r.code >= 300) throw new Error('database said ' + r.code + ': ' + String(r.text).slice(0, 200));
    activity_(act.model, act.pk(p, r), '🤖 ' + c.preview + ' — via Telegram bot, approved by ' + who, who);
    logPatch(id, { status:'done', decided_by: who, decided_at: new Date().toISOString(), result: 'done: ' + c.preview + (r && r.ref ? ' → ' + r.ref : '') });
    msg = '✅ Change #' + id + ' done (approved by ' + who + ').\n' + c.preview + (r && r.ref ? '\nPO: ' + r.ref : '') + '\nRefresh the app to see it.';
  } catch (e) {
    logPatch(id, { status:'failed', decided_by: who, decided_at: new Date().toISOString(), result: String(e.message || e) });
    msg = '⚠ Change #' + id + ' NOT done: ' + (e.message || e);
  }
  tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Approved' }); clear();
  send(cb.message.chat.id, msg);
}

/* ================================ Telegram in ================================= */
function doGet(){ return ContentService.createTextOutput('WR ERP bot: up'); }
function pollUpdates(){
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  var deadline = Date.now() + RUN_BUDGET_MS;
  try {
    var props = PropertiesService.getScriptProperties(), cache = CacheService.getScriptCache();
    var offset = +(props.getProperty('OFFSET') || 0);
    var r = tg('getUpdates', { offset: offset, timeout: 0, limit: 20, allowed_updates: ['message', 'callback_query'] });
    var j = {}; try { j = JSON.parse(r.getContentText()); } catch (e) {}
    (j.result || []).forEach(function(u){
      props.setProperty('OFFSET', String(u.update_id + 1));
      if (cache.get('u' + u.update_id)) return; cache.put('u' + u.update_id, '1', 21600);
      try { if (u.callback_query) onButton_(u.callback_query); else if (u.message) onMessage_(u.message, deadline); }
      catch (err) { console.error(err); }
    });
    /* carry on with questions that ran out of time last minute */
    var pend = rows_('erp_bot_log?select=id,job&kind=eq.question&status=eq.working&job=not.is.null&order=id.asc&limit=3');
    pend.forEach(function(p){
      if (Date.now() > deadline - 20000) return;
      var job = p.job; job.id = p.id;
      try { runJob_(job, deadline); }
      catch (e) { logPatch(p.id, { status:'failed', answer: String(e.message || e), job: null }); send(job.chatId, 'Sorry, that one failed: ' + String(e.message || e).slice(0, 150), { reply_to_message_id: job.msgId }); }
    });
  } finally { lock.releaseLock(); }
}
function installPolling(){
  tg('deleteWebhook', { drop_pending_updates: false });
  ScriptApp.getProjectTriggers().forEach(function(t){ if (t.getHandlerFunction() === 'pollUpdates') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pollUpdates').timeBased().everyMinutes(1).create();
  SpreadsheetApp.getActive; DriveApp.getRootFolder();     // ask for the Sheets/Drive permission now
  Logger.log('Polling every minute.');
}

function onMessage_(m, deadline){
  var chatId = String(m.chat.id), text = String(m.text || '');
  if (!text) return;
  var allowed = P('ALLOWED_CHAT_IDS').split(',').map(function(s){ return s.trim(); }).filter(String);
  var owner = P('OWNER_USER_ID'), fromId = String((m.from || {}).id || '');
  var isOwner = !!owner && fromId === owner;
  if (allowed.indexOf(chatId) < 0 && !isOwner) return;
  var botName = P('BOT_USERNAME'), isPrivate = m.chat.type === 'private';
  var mentioned = botName && text.toLowerCase().indexOf('@' + botName.toLowerCase()) >= 0;
  var replyToBot = m.reply_to_message && m.reply_to_message.from && m.reply_to_message.from.username === botName;
  if (!isPrivate && !mentioned && !replyToBot) return;

  var q = botName ? text.replace(new RegExp('@' + botName, 'ig'), '').trim() : text;
  var props = PropertiesService.getScriptProperties();
  if (isOwner && /^\/pause\b/i.test(q)) { props.setProperty('PAUSED', '1'); return send(chatId, '⏸ Paused until /resume.'); }
  if (isOwner && /^\/resume\b/i.test(q)) { props.deleteProperty('PAUSED'); return send(chatId, '▶ Resumed.'); }
  if (isOwner && /^\/usage\b/i.test(q)) return usage_(chatId);
  if (isOwner && /^\/prs\b/i.test(q)) return checkPRs(true);
  if (isOwner && /^\/fixes\b/i.test(q)) return listLog_(chatId, 'fix');
  if (/^\/changes\b/i.test(q)) return listLog_(chatId, 'change');
  if (props.getProperty('PAUSED') && !isOwner) return send(chatId, 'I am paused right now. Ask Zeus.');
  if (/^\/(start|help)\b/i.test(q)) return send(chatId,
    'Ask me anything about the ERP — stock, orders, plots, POs, production, buying.\n' +
    'I can also make changes (PO quantities, cancel/create POs, plot quantities, order status, stock corrections, ingredient settings). ' +
    'I show each change first; Zeus or Micko taps ✅ to apply it.\nBig tables come as Excel. Start with /deep for the hardest questions.\n/changes = recent changes.');
  if (replyToBot && m.reply_to_message.text) q = 'Earlier you said: "' + m.reply_to_message.text.slice(0, 2500) + '"\nFollow-up: ' + q;

  var day = day_(), n = +(props.getProperty('N' + day) || 0), cap = +(P('DAILY_LIMIT') || 80);
  if (n >= cap && !isOwner) return send(chatId, 'That is ' + cap + ' questions today — my daily limit. Try tomorrow or ask Zeus.');
  var uk = 'U' + fromId + '_' + Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyyMMddHH'), un = +(props.getProperty(uk) || 0);
  if (un >= +(P('USER_HOURLY') || 15) && !isOwner) return send(chatId, 'Too many questions from you this hour — try again later.');
  var spentD = +(props.getProperty('USD' + day) || 0), spentM = +(props.getProperty('USDM' + month_()) || 0);
  var capD = +(P('DAILY_USD') || 3), capM = +(P('MONTHLY_USD') || 95);
  if (spentD >= capD || spentM >= capM) {
    var why = spentM >= capM ? 'this month\'s budget ($' + capM + ')' : 'today\'s budget ($' + capD + ')';
    if (!props.getProperty('CAPHIT' + day)) { props.setProperty('CAPHIT' + day, '1'); if (owner) send(owner, '⚠ The ERP bot used up ' + why + ' and stopped answering. Raise DAILY_USD / MONTHLY_USD to restart it.'); }
    return send(chatId, 'I have used up ' + why + '. Ask Zeus.');
  }
  props.setProperty('N' + day, String(n + 1)); props.setProperty(uk, String(un + 1));

  var who = [m.from.first_name, m.from.last_name].filter(String).join(' ') + (m.from.username ? ' (@' + m.from.username + ')' : '');
  tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  var job = startJob_(q, who, fromId, chatId, m.message_id, isOwner);
  try { runJob_(job, deadline || (Date.now() + RUN_BUDGET_MS)); }
  catch (err) {
    if (job.id) logPatch(job.id, { status:'failed', answer: String(err.message || err), job: null });
    send(chatId, 'Sorry, I could not answer that just now (' + String(err.message || err).slice(0, 140) + ').', { reply_to_message_id: m.message_id });
  }
}

function onButton_(cb){
  var data = String(cb.data || ''), fromId = String(cb.from.id), owner = P('OWNER_USER_ID');
  var cm = /^(ca|cr):(\d+)$/.exec(data);
  if (cm) {
    if (approvers_().indexOf(fromId) < 0) { tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Only Zeus or Micko can approve changes.' }); return; }
    return decideChange_(cb, cm[2], cm[1] === 'ca');
  }
  if (fromId !== owner) { tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Only Zeus can decide this.' }); return; }
  var pm = /^(merge|close):(\d+)$/.exec(data); if (pm) return prButton_(cb, pm[1], pm[2]);
  var mm = /^(ok|no):(\d+)$/.exec(data); if (!mm) return;
  var status = mm[1] === 'ok' ? 'approved' : 'rejected';
  logPatch(mm[2], { status: status, decided_by: cb.from.username || fromId, decided_at: new Date().toISOString() });
  tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Fix #' + mm[2] + ' ' + status });
  tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  send(cb.message.chat.id, status === 'approved' ? 'App fix #' + mm[2] + ' approved. Tell Claude in the ERP project: "do the approved bot fixes".' : 'App fix #' + mm[2] + ' rejected.');
}

function listLog_(chatId, kind){
  var rows = rows_('erp_bot_log?select=id,created_at,fix_title,fix_detail,status,decided_by&kind=eq.' + kind + '&order=id.desc&limit=15');
  send(chatId, rows.length ? rows.map(function(x){ return '#' + x.id + ' · ' + x.status + (x.decided_by ? ' (' + x.decided_by + ')' : '') + ' · ' + String(x.created_at).slice(0, 10) + '\n  ' + String(x.fix_detail || x.fix_title).split('\n')[0]; }).join('\n')
                           : 'Nothing yet.');
}
function usage_(chatId){
  var props = PropertiesService.getScriptProperties();
  send(chatId, 'Spend today: $' + (+(props.getProperty('USD' + day_()) || 0)).toFixed(3) + ' of $' + (P('DAILY_USD') || 3) +
    '\nThis month: $' + (+(props.getProperty('USDM' + month_()) || 0)).toFixed(2) + ' of $' + (P('MONTHLY_USD') || 95) +
    '\nQuestions today: ' + (props.getProperty('N' + day_()) || 0) + (P('PAUSED') ? '\nStatus: ⏸ paused' : '\nStatus: ▶ running'));
}

/* ================ Claude's app fixes → merge from Telegram (GitHub) ================ */
function gh_(method, path, body){
  var r = UrlFetchApp.fetch('https://api.github.com/repos/' + (P('GITHUB_REPO') || 'mickomangalindan/WR-Inventory') + path, {
    method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + P('GITHUB_TOKEN'), Accept: 'application/vnd.github+json' },
    payload: body ? JSON.stringify(body) : undefined });
  var j = null; try { j = JSON.parse(r.getContentText()); } catch (e) {}
  return { code: r.getResponseCode(), json: j };
}
function checkPRs(all){
  var owner = P('OWNER_USER_ID'); if (!P('GITHUB_TOKEN') || !owner) return;
  var r = gh_('get', '/pulls?state=open&per_page=20');
  if (r.code >= 300 || !r.json) { if (all) send(owner, 'GitHub said ' + r.code + ' — check GITHUB_TOKEN.'); return; }
  var props = PropertiesService.getScriptProperties();
  if (all && !r.json.length) send(owner, 'No open pull requests.');
  r.json.forEach(function(pr){
    if (!all && props.getProperty('PR' + pr.number)) return;
    props.setProperty('PR' + pr.number, '1');
    send(owner, '🔧 App fix ready — PR #' + pr.number + ': ' + pr.title + '\n\n' + String(pr.body || '').slice(0, 2500) + '\n\n' + pr.html_url, {
      reply_markup: { inline_keyboard: [[ { text:'🚀 Merge (goes live)', callback_data:'merge:' + pr.number }, { text:'✖ Close', callback_data:'close:' + pr.number } ]] } });
  });
}
function prButton_(cb, act, num){
  tg('answerCallbackQuery', { callback_query_id: cb.id, text: act === 'merge' ? 'Merging…' : 'Closing…' });
  var r = act === 'merge' ? gh_('put', '/pulls/' + num + '/merge', { merge_method: 'merge' }) : gh_('patch', '/pulls/' + num, { state: 'closed' });
  tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  send(cb.message.chat.id, r.code < 300 ? (act === 'merge' ? '✅ PR #' + num + ' merged — live in about a minute.' : 'PR #' + num + ' closed.') : '⚠ GitHub refused (' + r.code + ')');
}
function installPRWatcher(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if (t.getHandlerFunction() === 'checkPRs') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('checkPRs').timeBased().everyMinutes(15).create();
}

/* ================================== setup ===================================== */
function selfTest(){
  ['TELEGRAM_BOT_TOKEN','BOT_USERNAME','ANTHROPIC_API_KEY','WR_SERVICE_ROLE','OWNER_USER_ID','APPROVER_IDS','ALLOWED_CHAT_IDS']
    .forEach(function(k){ Logger.log((P(k) ? 'ok      ' : 'MISSING ') + k); });
  Logger.log('Telegram: ' + tg('getMe', {}).getContentText().slice(0, 150));
  Logger.log('Polling trigger: ' + (ScriptApp.getProjectTriggers().some(function(t){ return t.getHandlerFunction() === 'pollUpdates'; }) ? 'ok' : 'MISSING — run installPolling()'));
  Logger.log('Supabase log table: ' + sbGet('erp_bot_log?select=id,job,action&limit=1').code + ' (200 = ready)');
  var pn = plotNeed_({});
  Logger.log('plot_need on ' + pn.plot + ': ' + (pn.rows ? pn.rows.length + ' ingredient rows' : pn.error));
  var job = { q:'selftest', who:'selfTest', chatId: P('OWNER_USER_ID'), isOwner:true, model: P('MODEL') || 'claude-sonnet-5-5', round:0,
    tot:{ input_tokens:0, output_tokens:0, cache_read_input_tokens:0, cache_creation_input_tokens:0 }, fixes:[], changes:[],
    messages:[{ role:'user', content:[{ type:'text', text:'How many custom orders are open right now? One line.' }] }] };
  var res = claude(job.model, job.messages, false);
  Logger.log('Claude (' + job.model + '): ' + JSON.stringify(res.content || []).slice(0, 200));
}
