/**
 * Wholesome Rabbit — Shopify inventory → ERP.  READ ONLY.
 * Google Apps Script · Shopify Admin GraphQL API
 *
 * WHAT IT DOES
 *   Reads, per variant SKU per location, the four inventory states Shopify
 *   keeps — available, on_hand, committed, incoming — and upserts them into
 *   public.shopify_inventory in Supabase. Regular Packs reads that table as its
 *   sellable figure, so nobody exports a CSV by hand again.
 *
 * IT CANNOT WRITE TO SHOPIFY. There is no mutation in this file. The scopes it
 *   needs are read_inventory, read_locations and read_products, and nothing
 *   else. It cannot change a stock level, a price, a product or an order, and
 *   it cannot touch Shopify's own sold / committed figures — those are computed
 *   by Shopify from real orders and we only ever look at them.
 *
 * WHY BOTH available AND on_hand
 *   available  what a customer can still buy — Shopify has already deducted the
 *              packs committed to unfulfilled orders. This is what drives "do we
 *              need to make more", because a committed pack is spoken for.
 *   on_hand    the physical count on the shelf, which is what OUR ledger tracks;
 *              the ledger knows nothing about commitments. So the app's drift
 *              check compares on_hand against the ledger. Comparing `available`
 *              against the ledger would show a permanent gap the size of the
 *              order book, and a warning that is always on is a warning nobody
 *              reads.
 *
 * fetched_at IS THE WATER LINE
 *   The app treats this reading as true at that instant and adds every ledger
 *   movement at that location recorded AFTER it. A transfer posted before the
 *   pull is already inside `available`; one posted after is added on top. The
 *   answer is the same either way, which is the entire point — it stops
 *   mattering whether warehouse posts the transfer or updates Shopify first.
 *   Never backdate fetched_at, and never write a reading you did not just take.
 *
 * TWO THINGS THIS SCRIPT REFUSES TO DO, BOTH LEARNED THE HARD WAY
 *   1. It skips UNTRACKED variants. On the Pasig opening audit those came back
 *      with no inventory at all and were read as zeros; custom-order pseudo-SKUs
 *      at −120 and −175 dragged a whole site to −646 kg. A variant Shopify is
 *      not tracking has no count, and no count is not a count of nothing.
 *   2. A null quantity is written as NULL, never as 0. `(+x || 0)` turned 182
 *      genuine readings into zeros once already. An absence and a zero are
 *      different facts and the database keeps them different.
 *
 * ---------------------------------------------------------------------------
 * SET UP — Project Settings → Script Properties. Never put these in the code.
 *   SUPABASE_URL    https://YOURPROJECT.supabase.co
 *   SUPABASE_KEY    the PUBLISHABLE (anon) key. NEVER the service_role key.
 *   SHOPIFY_SHOP    yourshop.myshopify.com          (no https://)
 *   SHOPIFY_TOKEN   Admin API access token, starts "shpat_"
 *   WR_LOCATIONS    (optional) JSON mapping every Shopify location name to one
 *                   of: "pasig", "bulacan", or "ignore".
 *                   {"*":"ignore","Pasig Hub":"pasig"}
 *                   "*" sets what an unlisted name means, so you need only name
 *                   the ones that ARE ours. Every name it skips that way is
 *                   printed on each run — check none of them is a real site.
 *                   Names containing "pasig" or "bulacan" are matched without
 *                   it. Everything else — every reseller and consignee — must be
 *                   listed as "ignore". Do NOT map a partner to one of our sites:
 *                   we cannot pull from their shelf, and counting their stock as
 *                   ours makes the kitchen under-produce.
 *
 * SHOPIFY SCOPES — read_inventory, read_locations, read_products.
 *   Shopify admin → Settings → Apps and sales channels → Develop apps → your
 *   app → Configure Admin API scopes → tick those three → Save → Install.
 *   Adding a READ scope does not alter any existing data.
 *
 * THE ORDER TO DO IT IN
 *   1. Run sql/wr_shopify_inventory.sql in Supabase.
 *   2. suggestLocations() — prints a ready-to-paste WR_LOCATIONS. Writes nothing.
 *   3. runSelfTest()      — connections and scopes only. Writes nothing.
 *   4. previewInventory() — prints what it would write. Writes nothing.
 *   5. DRY_RUN = false, then pullInventory() once by hand. Read the log.
 *   6. installTrigger()   — hourly from then on.
 * ---------------------------------------------------------------------------
 */

var DRY_RUN      = false;        // ← leave true until you have read one clean log
var API_VERSION  = '2025-07';
var VARIANT_PAGE = 25;          // variants per GraphQL page — keeps query cost well under the cap
var LEVEL_PAGE   = 5;           // locations per variant; we have two

/* ============================ plumbing ================================== */

function CFG_(k, required) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  if (required && !v) throw new Error('Missing Script Property: ' + k);
  return v;
}

function gql_(query, variables) {
  var res = UrlFetchApp.fetch(
    'https://' + CFG_('SHOPIFY_SHOP', true) + '/admin/api/' + API_VERSION + '/graphql.json',
    { method: 'post',
      contentType: 'application/json',
      headers: { 'X-Shopify-Access-Token': CFG_('SHOPIFY_TOKEN', true) },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) throw new Error('Shopify HTTP ' + code + ': ' + body.slice(0, 400));
  var json = JSON.parse(body);
  if (json.errors) {
    /* A missing scope shows up here, not as an HTTP error, and the message is
       the useful part — say it plainly rather than dumping the envelope. */
    var msg = json.errors.map(function (e) { return e.message; }).join(' | ');
    if (/access denied|not approved|scope/i.test(msg))
      throw new Error('Shopify refused the query — the app is probably missing '
        + 'read_inventory / read_locations. Add them in Configure Admin API scopes, '
        + 'save, and reinstall the app. Shopify said: ' + msg);
    throw new Error('Shopify GraphQL: ' + msg);
  }
  return json.data;
}

function sb_(path, opts) {
  opts = opts || {};
  var url = CFG_('SUPABASE_URL', true).replace(/\/+$/, '') + '/rest/v1/' + path;
  var key = CFG_('SUPABASE_KEY', true);
  var headers = { apikey: key, Authorization: 'Bearer ' + key };
  if (opts.prefer) headers.Prefer = opts.prefer;
  var res = UrlFetchApp.fetch(url, {
    method: opts.method || 'get',
    contentType: 'application/json',
    headers: headers,
    payload: opts.body || undefined,
    muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code >= 300) throw new Error('Supabase HTTP ' + code + ': ' + res.getContentText().slice(0, 400));
  var t = res.getContentText();
  return t ? JSON.parse(t) : null;
}

/* Shopify location name → the ERP's location_code.
   The ERP knows 'bulacan' and 'pasig' — our own two sites, in public.locations.
   Shopify also carries a location for every RESELLER and consignee, because
   that is how their stock is tracked for the storefront. Those are not ours to
   plan against: we cannot pull from a partner's shelf, and counting their stock
   as sellable makes the ERP under-produce. The app's own planning-locations
   dialog says the same thing about consignees.

   So a name resolves three ways, and the difference between the last two
   matters:
     'pasig' / 'bulacan'   ours — read it
     'ignore'              deliberately not ours — skip it, quietly
     null                  nobody has said — skip it, and SHOUT

   "Not looked at yet" and "decided this is not ours" must never look alike.
   Map a reseller to a real site by accident and its stock silently joins Pasig's
   shelf, which is a worse error than the feed not running at all. */
var IGNORE = '__ignore__';
function locMap_() {
  var raw = CFG_('WR_LOCATIONS', false);
  if (raw) { try { return JSON.parse(raw); } catch (e) {
    throw new Error('WR_LOCATIONS is not valid JSON: ' + raw); } }
  return null;
}
function _mapVal_(v) {
  if (v === null || v === false || v === '') return IGNORE;
  var t = String(v).toLowerCase();
  if (t === 'ignore' || t === 'skip') return IGNORE;
  return String(v);
}
function erpLoc_(shopifyName, map) {
  var n = String(shopifyName || '').trim();
  if (map && Object.prototype.hasOwnProperty.call(map, n)) return _mapVal_(map[n]);
  /* "*" sets what an UNLISTED name means. Use it when only one Shopify location
     is ours and everything else is a reseller — {"*":"ignore","Pasig Hub":"pasig"}
     — so you do not have to list every partner, and adding a new one does not
     break the feed. The cost is that a genuinely new WAREHOUSE of ours would be
     ignored too, so every defaulted name is printed by name on every run and by
     the self-test. Silence is the thing to avoid, not the default itself. */
  if (map && Object.prototype.hasOwnProperty.call(map, '*')) return _mapVal_(map['*']);
  var l = n.toLowerCase();
  if (l.indexOf('pasig') >= 0) return 'pasig';
  if (l.indexOf('bulacan') >= 0) return 'bulacan';
  return null;
}
/* Was this name decided explicitly, or did it fall through to "*"? */
function locListed_(shopifyName, map) {
  return !!(map && Object.prototype.hasOwnProperty.call(map, String(shopifyName || '').trim()));
}

/* A quantity that Shopify did not return is an ABSENCE. Keep it null. */
function qty_(list, name) {
  if (!list) return null;
  for (var i = 0; i < list.length; i++)
    if (list[i] && list[i].name === name)
      return (list[i].quantity == null) ? null : Number(list[i].quantity);
  return null;
}

/* ============================ the read ================================== */

var Q_VARIANTS =
  'query($cursor:String,$n:Int!,$m:Int!){' +
  '  productVariants(first:$n, after:$cursor){' +
  '    pageInfo{ hasNextPage endCursor }' +
  '    nodes{' +
  '      sku' +
  '      inventoryItem{' +
  '        tracked' +
  '        inventoryLevels(first:$m){' +
  '          nodes{' +
  '            location{ name }' +
  '            quantities(names:["available","on_hand","committed","incoming"]){ name quantity }' +
  '          }' +
  '        }' +
  '      }' +
  '    }' +
  '  }' +
  '}';

/**
 * Returns { rows, stats }. Reads Shopify and nothing else — no writes anywhere.
 */
function readInventory_() {
  var map = locMap_();
  var rows = [], cursor = null, page = 0;
  var stats = { variants: 0, untracked: 0, noSku: 0, noLevels: 0,
                unplacedLocations: {}, ignoredLocations: {}, defaultedLocations: {},
                nullAvailable: 0, pages: 0 };

  do {
    var data = gql_(Q_VARIANTS, { cursor: cursor, n: VARIANT_PAGE, m: LEVEL_PAGE });
    var conn = data.productVariants;
    page++;
    conn.nodes.forEach(function (v) {
      stats.variants++;
      var sku = (v.sku || '').trim();
      if (!sku) { stats.noSku++; return; }
      var item = v.inventoryItem || {};
      /* Untracked means Shopify holds no count for it. Reading that as zero is
         how the opening audit produced a negative site total. */
      if (item.tracked === false) { stats.untracked++; return; }
      var levels = (item.inventoryLevels && item.inventoryLevels.nodes) || [];
      if (!levels.length) { stats.noLevels++; return; }
      levels.forEach(function (lv) {
        var name = lv.location && lv.location.name;
        var code = erpLoc_(name, map);
        if (code === IGNORE) {
          var key = name || '(unnamed)';
          if (locListed_(name, map)) stats.ignoredLocations[key] = true;
          else stats.defaultedLocations[key] = true;      // fell through to "*"
          return;
        }
        if (!code) { stats.unplacedLocations[name || '(unnamed)'] = true; return; }
        var q = lv.quantities || [];
        var available = qty_(q, 'available');
        if (available == null) stats.nullAvailable++;
        rows.push({ sku: sku, location_name: code,
                    available: available,
                    on_hand:   qty_(q, 'on_hand'),
                    committed: qty_(q, 'committed'),
                    incoming:  qty_(q, 'incoming') });
      });
    });
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    if (cursor) Utilities.sleep(600);      // let the leaky bucket refill
  } while (cursor && page < 200);

  stats.pages = page;
  return { rows: rows, stats: stats };
}

/* ============================ the write ================================= */

/**
 * Pull Shopify inventory and upsert it into public.shopify_inventory.
 * With DRY_RUN = true it reads and reports and writes nothing.
 */
function pullInventory() {
  var t0 = new Date();
  var got = readInventory_();
  var rows = got.rows, st = got.stats;

  /* ONE TIMESTAMP FOR THE WHOLE RUN. Every row shares the instant the pull
     started, because the app uses it as a single water line. Stamping each row
     as it is written would put rows minutes apart and a movement could fall on
     the wrong side of two of them. */
  var stamp = t0.toISOString();
  rows.forEach(function (r) { r.fetched_at = stamp; });

  Logger.log('Read %s variant(s) over %s page(s) → %s inventory row(s)',
             st.variants, st.pages, rows.length);
  if (st.untracked) Logger.log('  skipped %s untracked variant(s) — Shopify holds no count for those', st.untracked);
  if (st.noSku)     Logger.log('  skipped %s variant(s) with no SKU', st.noSku);
  if (st.noLevels)  Logger.log('  skipped %s variant(s) with no inventory level anywhere', st.noLevels);
  if (st.nullAvailable) Logger.log('  %s row(s) came back with NO available figure — written as NULL, not 0', st.nullAvailable);
  var ignored = Object.keys(st.ignoredLocations);
  if (ignored.length) Logger.log('  skipped %s location(s) you marked "ignore": %s', ignored.length, ignored.join(', '));
  var defaulted = Object.keys(st.defaultedLocations);
  if (defaulted.length) Logger.log('  skipped %s location(s) by the "*" default — CHECK none of these is ours: %s',
    defaulted.length, defaulted.join(', '));
  var unplaced = Object.keys(st.unplacedLocations);
  if (unplaced.length) Logger.log('  ⚠ %s location(s) NOBODY HAS PLACED, and skipped: %s\n'
    + '     If it is one of ours, map it. If it is a reseller or consignee, mark it "ignore" —\n'
    + '     do NOT map it to pasig or bulacan, or their stock joins our shelf and we under-produce.\n'
    + '     WR_LOCATIONS e.g. {"%s":"ignore"}',
    unplaced.length, unplaced.join(', '), unplaced[0]);

  if (!rows.length) {
    Logger.log('⚠ NOTHING TO WRITE. Either every variant is untracked, or the '
      + 'location names do not match — check the two lines above before assuming '
      + 'the shop is empty.');
    return { written: 0, stats: st };
  }

  /* What the app will actually read, per location, so the log is checkable
     against the shop's own admin screen without opening the database. */
  var byLoc = {};
  rows.forEach(function (r) {
    var b = byLoc[r.location_name] = byLoc[r.location_name] || { skus: 0, available: 0, on_hand: 0 };
    b.skus++;
    if (r.available != null) b.available += r.available;
    if (r.on_hand   != null) b.on_hand   += r.on_hand;
  });
  Object.keys(byLoc).forEach(function (k) {
    Logger.log('  %s — %s SKU(s), available %s, on hand %s',
               k, byLoc[k].skus, byLoc[k].available, byLoc[k].on_hand);
  });

  if (DRY_RUN) {
    Logger.log('DRY_RUN is true — nothing was written. Set DRY_RUN = false to save this.');
    Logger.log('First 5 rows: %s', JSON.stringify(rows.slice(0, 5)));
    return { written: 0, stats: st, dryRun: true };
  }

  /* Upsert in chunks on the (sku, location_name) primary key. Re-running is
     free: the same pull twice leaves the same rows, just re-stamped. */
  var CHUNK = 200, written = 0;
  for (var i = 0; i < rows.length; i += CHUNK) {
    sb_('shopify_inventory', {
      method: 'post',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify(rows.slice(i, i + CHUNK)) });
    written += Math.min(CHUNK, rows.length - i);
  }
  Logger.log('✅ wrote %s row(s) at %s (took %ss)', written, stamp,
             Math.round((new Date() - t0) / 100) / 10);
  return { written: written, stats: st };
}

/** Reads and prints, never writes, whatever DRY_RUN says. */
function previewInventory() {
  var keep = DRY_RUN; DRY_RUN = true;
  try { return pullInventory(); } finally { DRY_RUN = keep; }
}

/* ============================ checks ==================================== */

/**
 * Connections and scopes. Writes nothing to either system.
 */
function runSelfTest() {
  var ok = 0, bad = 0;
  function t(name, fn) {
    try { var msg = fn(); Logger.log('  ok    %s%s', name, msg ? ' — ' + msg : ''); ok++; }
    catch (e) { Logger.log('  FAIL  %s — %s', name, e.message); bad++; }
  }

  t('Script properties present', function () {
    ['SUPABASE_URL', 'SUPABASE_KEY', 'SHOPIFY_SHOP', 'SHOPIFY_TOKEN'].forEach(function (k) { CFG_(k, true); });
    var key = CFG_('SUPABASE_KEY', true);
    if (/service_role/i.test(key) || key.length > 300)
      throw new Error('SUPABASE_KEY looks like a service_role key. Use the publishable (anon) key.');
    return 'and SUPABASE_KEY is not a service_role key';
  });

  t('Shopify reachable, read_locations granted', function () {
    var d = gql_('{ locations(first:10){ nodes{ name } } }');
    var names = d.locations.nodes.map(function (l) { return l.name; });
    return names.length + ' location(s): ' + names.join(', ');
  });

  t('read_inventory granted', function () {
    var d = gql_('query($n:Int!,$m:Int!){ productVariants(first:$n){ nodes{ sku inventoryItem{ tracked '
      + 'inventoryLevels(first:$m){ nodes{ location{name} quantities(names:["available","on_hand"]){ name quantity } } } } } } }',
      { n: 3, m: LEVEL_PAGE });
    var n = d.productVariants.nodes.length;
    return 'read ' + n + ' variant(s)';
  });

  t('Every Shopify location is accounted for', function () {
    var map = locMap_();
    var d = gql_('{ locations(first:100){ nodes{ name } } }');
    var names = d.locations.nodes.map(function (l) { return l.name; });
    var ours = names.filter(function (n) { var c = erpLoc_(n, map); return c && c !== IGNORE; });
    var skipped = names.filter(function (n) { return erpLoc_(n, map) === IGNORE && locListed_(n, map); });
    var byDefault = names.filter(function (n) { return erpLoc_(n, map) === IGNORE && !locListed_(n, map); });
    var bad = names.filter(function (n) { return !erpLoc_(n, map); });
    if (bad.length) throw new Error(bad.length + ' location(s) nobody has placed: ' + bad.join(', ')
      + '\n     A reseller or consignee should be marked "ignore" — NOT mapped to pasig or bulacan, '
      + 'or their stock joins our shelf and the kitchen under-produces.'
      + '\n     WR_LOCATIONS e.g. {"' + bad[0] + '":"ignore"}');
    if (!ours.length) throw new Error('NO Shopify location resolves to one of ours — '
      + 'the feed would read nothing. Names seen: ' + names.join(', '));
    return ours.length + ' ours (' + ours.join(', ') + ')'
      + (skipped.length ? (' · ' + skipped.length + ' ignored by name') : '')
      + (byDefault.length ? (' · ' + byDefault.length + ' ignored by the "*" default: ' + byDefault.join(', ')) : '');
  });

  t('Every code we map to exists in the ERP', function () {
    /* A typo here is silent: rows land under a location_code nothing reads, and
       the screen simply shows no Shopify figure with no error anywhere. */
    var map = locMap_();
    var d = gql_('{ locations(first:100){ nodes{ name } } }');
    var codes = {};
    d.locations.nodes.forEach(function (l) {
      var c = erpLoc_(l.name, map); if (c && c !== IGNORE) codes[c] = true; });
    var want = Object.keys(codes);
    if (!want.length) throw new Error('no Shopify location maps to one of ours — nothing would ever be read');
    var have = {}, rows = null;
    try { rows = sb_('locations?select=code'); }
    catch (e) {
      /* This check is a nicety, not a gate. The publishable key may not have
         SELECT on public.locations, and that is a fine state to be in — the
         feed itself never reads that table. Say so and move on rather than
         failing a self-test over a check that is optional.
         Postgres's own hint here is "GRANT SELECT ON public.locations TO anon".
         That one IS safe (two rows: a code and a name, nothing else) and
         sql/wr_locations_read.sql does it. Do NOT take the same hint on
         inventory_movements or products — inventory_movements carries unit_cost
         on every row, and anon is the key embedded in the app's front end. */
      if (/permission denied|42501|401/i.test(e.message))
        return 'skipped — the key cannot read public.locations (optional; see sql/wr_locations_read.sql)';
      throw e;
    }
    (rows || []).forEach(function (r) { have[r.code] = true; });
    if (!Object.keys(have).length) return 'skipped — public.locations is empty or unreadable';
    var missing = want.filter(function (c) { return !have[c]; });
    if (missing.length) throw new Error('these codes are not in public.locations: ' + missing.join(', ')
      + ' — known codes are ' + Object.keys(have).join(', '));
    return want.join(', ') + ' all exist';
  });

  t('Supabase table exists and is readable', function () {
    var r = sb_('shopify_inventory?select=sku&limit=1');
    return (r ? r.length : 0) + ' row(s) visible';
  });

  t('At least one TRACKED variant exists', function () {
    /* Sampling whichever variants come back first is how the opening audit
       spent a day looking at three untracked SKUs and concluding the endpoint
       was broken. Count tracked ones explicitly. */
    var d = gql_('query($n:Int!){ productVariants(first:$n){ nodes{ sku inventoryItem{ tracked } } } }', { n: 50 });
    var tracked = d.productVariants.nodes.filter(function (v) {
      return v.inventoryItem && v.inventoryItem.tracked !== false; });
    if (!tracked.length) throw new Error('none of the first 50 variants is tracked — '
      + 'this script would write nothing. Turn on inventory tracking in Shopify.');
    return tracked.length + ' of the first 50 are tracked';
  });

  Logger.log(bad ? ('\n%s FAILED, %s passed') : ('\nall %s checks passed'), bad ? bad : ok, ok);
  return { ok: ok, failed: bad };
}

/**
 * Prints a WR_LOCATIONS value you can paste straight into Script Properties.
 * Reads Shopify's location list and proposes: anything whose name mentions our
 * sites is ours, everything else is a reseller and is ignored by default.
 * READ WHAT IT PROPOSES before pasting — it is a guess from a name, and only
 * you know which shops are actually ours.
 */
function suggestLocations() {
  var d = gql_('{ locations(first:100){ nodes{ name } } }');
  var names = d.locations.nodes.map(function (l) { return l.name; });
  var ours = {}, others = [];
  names.forEach(function (n) {
    var l = n.toLowerCase();
    if (l.indexOf('pasig') >= 0) ours[n] = 'pasig';
    else if (l.indexOf('bulacan') >= 0) ours[n] = 'bulacan';
    else others.push(n);
  });
  /* "*" carries everything unlisted, so a new reseller next month does not break
     the feed. Every name it swallows is printed on each run, so a real site of
     ours cannot disappear quietly. */
  var proposal = { '*': 'ignore' };
  Object.keys(ours).forEach(function (k) { proposal[k] = ours[k]; });

  Logger.log('Shopify has %s location(s).', names.length);
  Logger.log('  OURS (by name):    %s', Object.keys(ours).length
    ? Object.keys(ours).map(function (k) { return k + ' -> ' + ours[k]; }).join(' · ') : '(none found!)');
  Logger.log('  NOT ours (ignored by the "*" default): %s', others.join(' · ') || '(none)');
  if (!Object.keys(ours).length)
    Logger.log('  ⚠ No name mentions pasig or bulacan. Add the right one by hand — '
      + 'the feed reads NOTHING until at least one location maps to a site of ours.');
  Logger.log('\nPaste this as the WR_LOCATIONS script property:\n%s', JSON.stringify(proposal));
  Logger.log('\nIf you only want ONE site read, delete the others from that JSON — '
    + 'anything not listed falls to "*" and is skipped.');
  return proposal;
}

/* ============================ schedule ================================== */

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pullInventory') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pullInventory').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger installed for pullInventory. DRY_RUN is currently %s.', DRY_RUN);
  if (DRY_RUN) Logger.log('⚠ DRY_RUN is still true, so the schedule will read and write nothing.');
}

function removeTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pullInventory') { ScriptApp.deleteTrigger(t); n++; } });
  Logger.log('Removed %s trigger(s).', n);
}