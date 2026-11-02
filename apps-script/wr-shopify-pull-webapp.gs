/**
 * Wholesome Rabbit — manual pull endpoint.  ADD THIS TO wr-shopify-pull.gs.
 * Paste it at the bottom of the existing file. Change nothing above it.
 *
 * WHY THIS EXISTS
 *   pullInventory() runs on an hourly time-based trigger, and a time-based
 *   trigger has no handle a web page can pull. So the ERP's 🔄 Sync Shopify
 *   button could only ever re-read what the last run saved. This gives the
 *   button something to call.
 *
 * WHAT IT IS SAFE AGAINST, AND WHAT IT IS NOT
 *   The ERP is served from GitHub Pages. Everything it holds is public — this
 *   URL and the shared word included. SYNC_TOKEN is NOT authentication. It
 *   stops drive-by scanners and nothing more, so this endpoint is built to be
 *   safe for a stranger to call:
 *
 *     · it calls pullInventory(), which contains no Shopify mutation at all;
 *     · it writes only to public.shopify_inventory, which the ERP already reads;
 *     · it refuses to run again within COOLDOWN_S and answers with the age of
 *       the last run instead, so it cannot be used to burn the Shopify API
 *       quota by holding down a key;
 *     · it takes a lock, so two people pressing at once produce one pull.
 *
 *   The worst a stranger can do is make us read our own shop, slowly. Do not
 *   extend this endpoint with anything that writes to Shopify, and never
 *   return SHOPIFY_TOKEN, SUPABASE_KEY or any other property from it.
 *
 * SET UP
 *   1. Project Settings → Script Properties → add SYNC_TOKEN = any hard-to-guess
 *      word. (If it is missing the endpoint refuses every call, which is the
 *      safe default — it is never "open to all" by accident.)
 *   2. Deploy → New deployment → type Web app
 *        Execute as          Me
 *        Who has access      Anyone
 *      Copy the /exec URL. The /dev URL requires a Google login and will not
 *      work from the ERP.
 *   3. In the ERP: Shopify Sync → ⚙ Manual pull → paste the URL and the word →
 *      Test it → Save.
 *   4. LEAVE THE HOURLY TRIGGER ALONE. This is a top-up, not a replacement: if
 *      nobody presses the button the feed must still be current.
 *
 *   Re-deploy after any edit — Apps Script serves the deployed version, not the
 *   one in the editor, and "I changed it and nothing happened" is always this.
 */

var COOLDOWN_S = 90;     // a stranger holding down the button costs us one pull a minute and a half

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    var want = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
    /* No token configured means not set up. Refusing is the safe reading of
       that, never "let everyone in". */
    if (!want) return _out_({ ok: false, error: 'SYNC_TOKEN is not set in Script Properties' });
    if (String(p.token || '') !== String(want)) return _out_({ ok: false, error: 'bad token' });

    var props = PropertiesService.getScriptProperties();
    var last = Number(props.getProperty('LAST_PULL_MS') || 0);
    var ageS = last ? Math.round((Date.now() - last) / 1000) : null;

    /* `dry=1` is what the ERP's "Test it" button calls: it proves the
       deployment, the access setting and the token without touching Shopify. */
    if (String(p.dry || '') === '1')
      return _out_({ ok: true, dry: true, cooldown_s: COOLDOWN_S,
                     last_pull_age_s: ageS, dry_run_flag: DRY_RUN });

    if (ageS !== null && ageS < COOLDOWN_S)
      return _out_({ ok: true, skipped: 'ran ' + ageS + 's ago — nothing to do within ' + COOLDOWN_S + 's',
                     written: 0, last_pull_age_s: ageS });

    /* One pull at a time. Two people pressing together should produce one
       reading, not two interleaved ones fighting over the same timestamp. */
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000))
      return _out_({ ok: true, skipped: 'another pull is already running', written: 0 });
    try {
      var r = pullInventory();                       // the existing function, unchanged
      props.setProperty('LAST_PULL_MS', String(Date.now()));
      return _out_({ ok: true, written: (r && r.written) || 0,
                     variants: (r && r.stats && r.stats.variants) || 0,
                     dry_run_flag: DRY_RUN });
    } finally { lock.releaseLock(); }

  } catch (err) {
    /* Say what broke, but never echo a property value back to a public URL. */
    return _out_({ ok: false, error: String(err && err.message || err).slice(0, 300) });
  }
}

/* A web app cannot answer a CORS preflight, so the ERP calls this with a plain
   GET and no custom headers. doPost exists only so a stray POST gets JSON back
   rather than an HTML error page. */
function doPost(e) { return doGet(e); }

function _out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}