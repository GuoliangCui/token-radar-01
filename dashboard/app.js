// Token Radar dashboard (radar-2). Reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, search and filters, a per-protocol detail dialog with the model's full
// working and the farm plan board.json carries, plus a Live token tab that keeps already-tokenized
// protocols visibly separate. No network: every byte it shows is in data.js.
// Hashes: #detail=<slug> opens a protocol, #filter=<category> presets the category filter.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', watchOnly: false, tab: 'pre-token', sort: 'rank', dir: 1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function median(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) node.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('detail')) state.selected = params.get('detail');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('filter')) state.category = params.get('filter');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('q')) state.q = params.get('q');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.category !== 'all') params.set('filter', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.q) params.set('q', state.q);
    if (state.selected) params.set('detail', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.watchOnly && !r.watchlist) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'rank') { av = a.rank; bv = b.rank; }
      else if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'multiple') { av = a.model.category_multiple; bv = b.model.category_multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.rank - b.rank;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'Model ', el('b', { text: DATA.model_version + ' comparables' })),
        el('span', { text: 'Source: DefiLlama protocol index (sealed snapshot)' })
      )
    );
  }

  function lede() {
    var med = median(DATA.rows.map(function (r) { return r.implied_value_usd; }));
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', null, 'Which pre-token protocol is ', el('em', { text: 'worth farming next' }), '?'),
        el('p', { text: 'Every protocol in the snapshot that records no token and is not a wrapped, staked or bridged product of one that trades, ranked by what its launch would be worth under a comparables model. The watchlist is the floor, never the ceiling: the board also ranks ' + DATA.early_size + ' early protocols below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor. Implied value is a model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Protocols ranked' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Median implied value' }), el('b', { text: fmtUsd(med) })),
        el('div', { class: 'fact' }, el('span', { text: 'Snapshot date' }), el('b', { text: DATA.as_of }))
      )
    );
  }

  function methodPanel() {
    var m = DATA.model, c = DATA.comparables;
    var body = [
      el('h2', { text: 'How implied value is computed' }),
      el('p', { text: 'The model learns from the ' + c.tokenized_count + ' protocols in this snapshot that already have a token: for each, market cap divided by TVL. A category is priced at the median multiple of its own tokenized protocols when at least ' + m.min_comparables + ' exist; thinner categories fall back to the global median of ' + c.global_multiple + 'x. Multiples are clamped between ' + m.multiple_floor + 'x and ' + m.multiple_cap + 'x. Already-tokenized protocols are never ranked: they sit in the Live token tab at their real market caps.' }),
      el('div', { class: 'formula', text: 'implied value = TVL x category multiple x growth factor x age factor x chain factor' }),
      el('p', { text: 'Growth factor: 1 + clamp(7-day TVL change, ' + m.growth_floor_pct + '%, +' + m.growth_cap_pct + '%) x ' + m.growth_weight + ', held between 0.75 and 1.50; a protocol with no reported change scores a neutral 1. Age factor: ' + m.age_floor + ' rising to ' + (m.age_floor + m.age_range) + ' over ' + m.age_days_cap + ' days since the protocol was first listed (an unrecorded age uses ' + m.unknown_age_days + ' days), because a launch is worth more from a protocol that has already run for years with no token. Chain factor: +5% per chain beyond the first, up to ' + m.chain_count_cap + ' chains. No protocol name is special-cased; open any row to see its own working.' })
    ];
    var cats = c.categories.filter(function (x) { return x.comparables >= 2; });
    var tbl = el('table', null,
      el('thead', null, el('tr', null,
        el('th', { text: 'Category' }), el('th', { class: 'n', text: 'Tokenized comparables' }),
        el('th', { class: 'n', text: 'Median mcap / TVL' }), el('th', { class: 'n', text: 'Multiple in force' }), el('th', { text: 'Source' }))),
      el('tbody', null, cats.map(function (x) {
        return el('tr', null,
          el('td', { text: x.category }), el('td', { class: 'n', text: String(x.comparables) }),
          el('td', { class: 'n', text: x.median_multiple + 'x' }), el('td', { class: 'n', text: x.used_multiple + 'x' }),
          el('td', { text: x.source === 'category' ? 'category median' : 'global fallback' }));
      }))
    );
    body.push(el('details', null, el('summary', { text: 'The comparables table (' + cats.length + ' categories)' }), tbl));
    return el('section', { class: 'method' }, body);
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    function select(id, label, values, current, onchange) {
      var s = el('select', { id: id, 'aria-label': label },
        el('option', { value: 'all', text: label === 'Category' ? 'All categories' : 'All chains' }),
        values.map(function (v) { return el('option', { value: v, text: v, selected: v === current ? 'selected' : null }); }));
      s.addEventListener('change', function () { onchange(s.value); writeHash(); render(); });
      return s;
    }
    var catSel = select('category', 'Category', categories, state.category, function (v) { state.category = v; });
    var chainSel = select('chain', 'Chain', chains, state.chain, function (v) { state.chain = v; });
    var watch = el('input', { type: 'checkbox', id: 'watchonly', checked: state.watchOnly ? 'checked' : null });
    watch.addEventListener('change', function () { state.watchOnly = watch.checked; render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('label', { class: 'field check', for: 'watchonly' }, watch, 'Watchlist only'),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' of ' + DATA.board_size + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label, numeric) {
    var arrow = state.sort === key ? (state.dir > 0 ? ' ^' : ' v') : '';
    return el('th', { scope: 'col', class: numeric ? 'numh' : '' },
      el('button', { type: 'button', onclick: function () {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = key === 'rank' || key === 'name' || key === 'age' ? 1 : -1; }
        render();
      } }, label + arrow)
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        el('button', { class: 'button', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchOnly = false; writeHash(); render(); } })
      ));
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', null, r.name, r.watchlist ? el('span', { class: 'badge', text: 'Watchlist' }) : null),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: r.model.category_multiple + 'x' }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', { class: 'board' },
          el('caption', { class: 'sub', text: 'Pre-token protocols ranked by implied value. Select any row for its model working and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank', true), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL', true),
            sortHeader('growth', '7d', true), sortHeader('age', 'Age', true), sortHeader('multiple', 'Multiple', true),
            sortHeader('implied', 'Implied value', true), el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: 'n/a' }),
        el('td', { class: 'num', text: r.mcap_usd === null ? 'n/a' : (Math.round((r.mcap_usd / r.tvl_usd) * 100) / 100) + 'x' }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', { class: 'board' },
          el('caption', { class: 'sub', text: 'Already tokenized: these protocols trade today, so their market cap is a fact, not a model. They price the comparables and are never ranked with the pre-token board.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }),
            el('th', { class: 'numh', scope: 'col', text: 'TVL' }), el('th', { class: 'numh', scope: 'col', text: '7d' }),
            el('th', { class: 'numh', scope: 'col', text: 'Age' }), el('th', { class: 'numh', scope: 'col', text: 'Mcap / TVL' }),
            el('th', { class: 'numh', scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    var m = row.model;
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'rank', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' · watchlist' : ' · early, below the floor') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · records no token' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    function cell(label, value) { return el('div', null, el('span', { text: label }), el('b', { text: value })); }
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value: the working' }),
      el('div', { class: 'equation' },
        cell('TVL', fmtUsd(row.tvl_usd)),
        cell('Category multiple', m.category_multiple + 'x (' + (m.multiple_source === 'category' ? 'category median, ' + m.comparables + ' comparables' : 'global fallback, ' + m.comparables + ' in category') + ')'),
        cell('7-day TVL change', m.growth_pct === null ? 'not reported' : fmtPct(m.growth_pct)),
        cell('Growth factor', 'x ' + m.growth_factor),
        cell('Age since first listed', row.age_days === null ? 'not recorded (365d assumed)' : fmtAge(row.age_days) + ' (' + row.age_days + ' days)'),
        cell('Age factor', 'x ' + m.age_factor),
        cell('Chains', String(m.chain_count)),
        cell('Chain factor', 'x ' + m.chain_factor),
        el('div', { class: 'total' }, el('span', { text: 'Implied value if it launched at these figures' }), el('b', { text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'TVL x multiple x growth factor x age factor x chain factor, rounded to whole dollars; factors above are shown to 4 decimal places. An estimate of worth, not a prediction that a token will launch.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (!dialog.isConnected) app.appendChild(dialog);
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  function render() {
    var selected = state.selected;
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(methodPanel());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    shell.appendChild(el('footer', { class: 'foot', text: 'Implied values are this board\u2019s own model claims from a sealed DefiLlama snapshot dated ' + DATA.as_of + '. A protocol here records no token; that is a statement about the record, not proof none exists.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (selected) openDetail(selected);
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
