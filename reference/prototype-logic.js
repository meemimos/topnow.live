
const DURS = [
  { h: 1, name: 'Quick flex' },
  { h: 3, name: 'Lunch to dinner' },
  { h: 6, name: 'Half a day' },
  { h: 12, name: 'Overnight' },
  { h: 24, name: 'Own the day' }
];
const SLOTS = [
  { rate: 5, surge: 1.7, queue: 4, ahead: [3, 3, 3, 3], note: 'Four in the queue for slot 01. Rate holds at 1.7\u00d7 until it thins out.' },
  { rate: 3, surge: 1.2, queue: 3, ahead: [3, 3, 3], note: 'Three waiting on slot 02. Rate is 1.2\u00d7 right now.' },
  { rate: 2, surge: 1, queue: 0, ahead: [], note: '' }
];
const PLATFORMS = {
  GitHub: { prefix: 'github.com/', eg: 'mira' },
  YouTube: { prefix: 'youtube.com/@', eg: 'parcelkit' },
  Instagram: { prefix: 'instagram.com/', eg: 'studio.offcut' },
  TikTok: { prefix: 'tiktok.com/@', eg: 'halfbuilt' },
  Reddit: { prefix: 'reddit.com/user/', eg: 'kerncase' },
  Website: { prefix: '', eg: '' }
};
const money = (n) => n.toFixed(2);
const LIVE = [
  { slot: 0, handle: '@mira_builds', tag: 'GH', dur: 6, rate: 8.5, boughtAgo: 3.2 },
  { slot: 1, handle: '@parcelkit', tag: 'YT', dur: 3, rate: 3.45, boughtAgo: 2.3 }
];
const QUEUED = [
  { slot: 0, handle: '@dovetail_app', tag: 'GH', dur: 3, rate: 8.5, boughtAgo: 1.6 },
  { slot: 1, handle: '@tuesday_type', tag: 'IG', dur: 3, rate: 3.6, boughtAgo: 1.4 },
  { slot: 0, handle: '@nine_lives_cli', tag: 'GH', dur: 3, rate: 8.2, boughtAgo: 1.1 },
  { slot: 1, handle: '@kerncase', tag: 'WEB', dur: 3, rate: 3.45, boughtAgo: 0.8 },
  { slot: 0, handle: '@studio_offcut', tag: 'IG', dur: 3, rate: 7.65, boughtAgo: 0.6 },
  { slot: 1, handle: '@rowboat.fm', tag: 'RD', dur: 3, rate: 3.6, boughtAgo: 0.4 },
  { slot: 0, handle: '@halfbuilt', tag: 'TT', dur: 3, rate: 8.5, boughtAgo: 0.2 }
];
const ENDED_HANDLES = ['@ferrite_io', '@quiet_ops', '@postmark_dev', '@slowbuild', '@thirdshelf', '@nine_kb', '@bracketsoup', '@lowtide_cc', '@margin_notes', '@paperclip_fm', '@sundry_tools', '@offhours'];
const ENDED_TAGS = ['GH', 'YT', 'IG', 'TT', 'RD', 'WEB'];
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4)] || 'th');
const ask = (i) => Math.round(SLOTS[i].rate * SLOTS[i].surge * 100) / 100;
const UP = '#00a000';
const DOWN = '#c40000';
const SALE = '#000080';
const SPECS = [
  { base: 5, hours: 120, vol: 0.055, maxS: 2, sales: 64, rev: 0.02 },
  { base: 3, hours: 120, vol: 0.014, maxS: 1.25, sales: 41, rev: 0.06 },
  { base: 2, hours: 9, vol: 0, maxS: 1, sales: 6 }
];

function lcg(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }

function buildMarket(now) {
  const HR = 3600e3;
  const endH = Math.floor(now / HR) * HR;
  return SPECS.map((sp, i) => {
    const rnd = lcg(9161 + i * 7717);
    let surge = 1;
    const candles = [];
    for (let h = sp.hours - 1; h >= 0; h--) {
      const t = (endH - h * HR) / 1000;
      const ticks = [];
      for (let k = 0; k < 24; k++) {
        surge = surge + (1 - surge) * (sp.rev || 0) + (rnd() - 0.46) * sp.vol * 4;
        surge = Math.min(sp.maxS, Math.max(1, surge));
        ticks.push(Math.round(sp.base * surge * 100) / 100);
      }
      candles.push({
        time: t, open: ticks[0], close: ticks[23],
        high: Math.max.apply(null, ticks), low: Math.min.apply(null, ticks)
      });
    }
    const durs = [1, 3, 6, 12, 24];
    const sales = [];
    for (let n = 0; n < sp.sales; n++) {
      const ci = Math.floor(rnd() * candles.length);
      const c = candles[ci];
      const dur = durs[Math.floor(rnd() * durs.length)];
      const at = c.time + Math.floor(rnd() * 60) * 60;
      sales.push({ time: c.time, at, rate: c.close, dur, paid: Math.round(c.close * dur * 100) / 100 });
    }
    sales.sort((a, b) => a.time - b.time);
    const last = candles[candles.length - 1];
    const a = ask(i);
    last.close = a;
    last.high = Math.max(last.high, a);
    last.low = Math.min(last.low, a);
    return { candles, sales, base: sp.base };
  });
}

function clock12(sec) {
  const d = new Date(sec * 1000);
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ap;
}

function HitCounter(props) {
  const digits = String(Math.max(0, props.value)).padStart(props.pad || 7, '0').split('');
  const size = props.size || 26;
  return React.createElement('div', {
    style: {
      display: 'flex', gap: '2px', background: '#000000', border: '1px solid #000000',
      boxShadow: 'inset 1px 1px 0 #303030', padding: '3px'
    }
  }, digits.map((ch, i) => React.createElement('span', {
    key: i,
    style: {
      position: 'relative', display: 'block', width: '0.72em', height: '1em', overflow: 'hidden',
      fontFamily: 'Silkscreen, monospace', fontSize: size + 'px', lineHeight: '1em',
      color: '#ffb000', background: '#0a0a0a', textAlign: 'center'
    }
  }, React.createElement('span', {
    style: {
      position: 'absolute', top: 0, left: 0, display: 'block', width: '100%',
      transform: 'translateY(' + (-Number(ch) * 10) + '%)',
      transition: props.roll ? 'transform 400ms cubic-bezier(.2,.7,.2,1)' : 'none'
    }
  }, ['0','1','2','3','4','5','6','7','8','9'].map(n => React.createElement('span', {
    key: n, style: { display: 'block', height: '1em', lineHeight: '1em' }
  }, n))))));
}

class Component extends DCLogic {
  state = { slot: 0, durIdx: 1, now: Date.now(), t0: Date.now(), visits: 128407, online: 3, views: 4126, clicks: 318,
            mkt: 0, range: 24, narrow: false, expanded: false,
            fSlot: 0, modal: null, fHandle: '', fPlatform: 'GitHub', fPitch: '', fUrl: '', fName: '', err: '' };
  chartRef = React.createRef();

  componentDidMount() {
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.market = buildMarket(Date.now());
    this.onResize = () => {
      const n = window.innerWidth < 620;
      if (n !== this.state.narrow) this.setState({ narrow: n });
      else if (this.chart && this.chartRef.current) this.chart.applyOptions({ width: this.chartRef.current.clientWidth });
    };
    window.addEventListener('resize', this.onResize);
    this.setState({ narrow: window.innerWidth < 620 });
    this.syncChart();
    this.timer = setInterval(() => this.setState({ now: Date.now() }), 1000);
    this.vTimer = setInterval(() => this.setState(s => ({ visits: s.visits + 1 + Math.floor(Math.random() * 3) })), 2200);
    this.oTimer = setInterval(() => this.setState(s => ({ online: Math.max(1, s.online + Math.round((Math.random() - 0.45) * 9)) })), 4000);
    this.pTimer = setInterval(() => this.setState(s => ({
      views: s.views + Math.floor(Math.random() * 4),
      clicks: s.clicks + (Math.random() < 0.35 ? 1 : 0)
    })), 2600);
    setTimeout(() => this.setState({ online: 812 }), 400);
  }
  componentDidUpdate() { this.syncChart(); }

  componentWillUnmount() {
    [this.timer, this.vTimer, this.oTimer, this.pTimer].forEach(clearInterval);
    window.removeEventListener('resize', this.onResize);
    if (this.chart) { this.chart.remove(); this.chart = null; }
  }

  ledgerRows() {
    const now = this.state.now;
    const HR = 3600e3;
    const f = this.state.fSlot;
    const rem = [this.remain(0), this.remain(1), 0];
    const pass = (r) => f === 0 || r.slot === f - 1;
    const stamp = (ms) => clock12(Math.round(ms / 1000));

    const live = LIVE.filter(pass).map(r => ({
      handle: r.handle, tag: r.tag, slot: '0' + (r.slot + 1), dur: r.dur + 'h',
      rate: '$' + money(r.rate), mult: (r.rate / SLOTS[r.slot].rate).toFixed(2) + '\u00d7 base',
      paid: '$' + money(r.rate * r.dur), bought: stamp(now - r.boughtAgo * HR),
      badge: 'LIVE', clock: this.hms(rem[r.slot])
    }));

    const cursor = [now + rem[0], now + rem[1], now];
    const queued = QUEUED.filter(pass).map(r => {
      const start = cursor[r.slot];
      cursor[r.slot] = start + r.dur * HR;
      return {
        handle: r.handle, tag: r.tag, slot: '0' + (r.slot + 1), dur: r.dur + 'h',
        rate: '$' + money(r.rate), mult: (r.rate / SLOTS[r.slot].rate).toFixed(2) + '\u00d7 base',
        paid: '$' + money(r.rate * r.dur), bought: stamp(now - r.boughtAgo * HR),
        badge: 'QUEUED', clock: '~' + stamp(start)
      };
    });

    const all = [];
    (this.market || []).forEach((m, si) => m.sales.forEach((s, k) => all.push({ s, si, k })));
    all.sort((a, b) => b.s.at - a.s.at);
    const ended = all.filter(x => f === 0 || x.si === f - 1).slice(0, 10).map((x, i) => ({
      handle: ENDED_HANDLES[i % ENDED_HANDLES.length],
      tag: ENDED_TAGS[(i + x.si) % ENDED_TAGS.length],
      slot: '0' + (x.si + 1), dur: x.s.dur + 'h',
      rate: '$' + money(x.s.rate), mult: '',
      paid: '$' + money(x.s.paid), bought: clock12(x.s.at),
      badge: 'ENDED', clock: clock12(x.s.at + x.s.dur * 3600)
    }));

    return { live, queued, ended };
  }

  remain(i) {
    const end = i === 0 ? this.state.t0 + 2 * 3600e3 + 47 * 60e3 + 12e3 : this.state.t0 + 41 * 60e3 + 6e3;
    return Math.max(0, end - this.state.now);
  }

  hms(ms) {
    return this.pad(ms / 3600e3) + ':' + this.pad((ms / 60e3) % 60) + ':' + this.pad((ms / 1000) % 60);
  }

  view() {
    const m = (this.market || [])[this.state.mkt] || { candles: [], sales: [], base: 0 };
    const sparse = m.candles.length < 20;
    const cut = m.candles.length - this.state.range;
    const candles = sparse ? m.candles : m.candles.slice(Math.max(0, cut));
    const from = candles.length ? candles[0].time : 0;
    return { m, sparse, candles, sales: m.sales.filter(s => s.time >= from) };
  }

  syncChart() {
    const LC = window.LightweightCharts;
    const el = this.chartRef.current;
    const v = this.view();
    if (v.sparse || !el) {
      if (this.chart) { this.chart.remove(); this.chart = null; this.key = null; }
      return;
    }
    if (!LC) {
      if (!this.libTries) this.libTries = 0;
      if (this.libTries++ < 60) setTimeout(() => this.syncChart(), 120);
      return;
    }
    const spark = this.state.narrow && !this.state.expanded;
    const key = this.state.mkt + '/' + this.state.range + '/' + (spark ? 's' : 'f');
    if (this.chart && this.key === key) {
      this.chart.applyOptions({ width: el.clientWidth });
      return;
    }
    if (this.chart) { this.chart.remove(); this.chart = null; }
    this.key = key;

    const chart = LC.createChart(el, {
      width: el.clientWidth,
      height: spark ? 110 : 260,
      layout: { background: { color: '#ffffff' }, textColor: '#000000', fontFamily: 'Verdana, Geneva, sans-serif', fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: spark ? 'rgba(0,0,0,0)' : '#e2e2e2' }, horzLines: { color: spark ? 'rgba(0,0,0,0)' : '#e2e2e2' } },
      rightPriceScale: { visible: !spark, borderColor: '#000000' },
      timeScale: { visible: !spark, borderColor: '#000000', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScroll: !spark,
      handleScale: !spark
    });

    let series;
    if (spark) {
      series = chart.addSeries(LC.LineSeries, { color: '#000080', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
      series.setData(v.candles.map(c => ({ time: c.time, value: c.close })));
    } else {
      series = chart.addSeries(LC.CandlestickSeries, {
        upColor: UP, borderUpColor: UP, wickUpColor: UP,
        downColor: 'rgba(0,0,0,0)', borderDownColor: DOWN, wickDownColor: DOWN,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
      });
      series.setData(v.candles);
      series.createPriceLine({
        price: v.m.base, color: '#000000', lineWidth: 1, lineStyle: LC.LineStyle.Dashed,
        axisLabelVisible: true, title: 'base'
      });
      LC.createSeriesMarkers(series, v.sales.map(s => ({
        time: s.time, position: 'belowBar', color: SALE, shape: 'circle', size: 0.6
      })));
    }
    chart.timeScale().fitContent();
    this.chart = chart;
  }

  pad(n) { return String(Math.max(0, Math.floor(n))).padStart(2, '0'); }

  time(d) {
    let h = d.getHours();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + this.pad(d.getMinutes()) + ' ' + ap;
  }

  marketVals() {
    const mk = this.market || [];
    const sel = this.state.mkt;
    const v = this.view();
    const bev = (on) => ({
      bg: on ? '#000080' : '#c6c6c6',
      fg: on ? '#ffffff' : '#000000',
      sh: on ? 'inset 3px 3px 0 #00003f, inset -3px -3px 0 #5b5bd6' : 'inset -3px -3px 0 #7b7b7b, inset 3px 3px 0 #ffffff'
    });
    const out = {};
    [0, 1, 2].forEach(i => {
      const m = mk[i] || { candles: [], base: SPECS[i].base };
      const last = m.candles.length ? m.candles[m.candles.length - 1].close : SPECS[i].base;
      const pct = ((last / SPECS[i].base) - 1) * 100;
      const b = bev(sel === i);
      const n = i + 1;
      out['m' + n + 'Price'] = last.toFixed(2) + '/hr';
      out['m' + n + 'Chg'] = (pct >= 0.5 ? '+' : '') + pct.toFixed(1) + '%';
      out['m' + n + 'ChgColor'] = sel === i ? (pct >= 0.5 ? '#7dff7d' : '#ffffff') : (pct >= 0.5 ? '#006000' : '#333333');
      out['m' + n + 'Bg'] = b.bg; out['m' + n + 'Fg'] = b.fg; out['m' + n + 'Sh'] = b.sh;
      out['b' + n] = SLOTS[i].rate.toFixed(2);
      out['s' + n] = SLOTS[i].surge.toFixed(1);
      out['q' + n] = SLOTS[i].queue;
    });
    [12, 24, 48, 120].forEach(r => {
      const b = bev(this.state.range === r);
      out['r' + r + 'Bg'] = b.bg; out['r' + r + 'Fg'] = b.fg; out['r' + r + 'Sh'] = b.sh;
    });

    const spark = this.state.narrow && !this.state.expanded;
    const tail = v.candles.slice(-6);
    const flat = !v.sparse && tail.length === 6 && tail.every(c => Math.abs(c.close - v.m.base) / v.m.base < 0.015);

    return Object.assign(out, {
      chartRef: this.chartRef,
      chartVisible: !v.sparse,
      chartH: spark ? 110 : 260,
      showExpand: !v.sparse && spark,
      sparse: v.sparse,
      sparseMsg: 'Slot 0' + (sel + 1) + ' has taken ' + v.m.sales.length + ' sales since it opened ' + v.m.candles.length + ' hours ago.',
      flat: flat,
      flatMsg: 'Slot 0' + (sel + 1) + ' has sat at its base rate of $' + v.m.base.toFixed(2) + '/hr for the last six hours. No queue, no surge — it is available at base right now.',
      tapeCount: v.m.sales.length,
      tape: v.m.sales.slice().sort((a, b) => a.at - b.at).slice(-8).reverse().map(s => ({
        time: clock12(s.at), rate: '$' + s.rate.toFixed(2), dur: s.dur + 'h', paid: '$' + s.paid.toFixed(2)
      })),
      ...(() => {
        const rows = this.ledgerRows();
        const fb = (on) => ({
          bg: on ? '#000080' : '#c6c6c6', fg: on ? '#ffffff' : '#000000',
          sh: on ? 'inset 3px 3px 0 #00003f, inset -3px -3px 0 #5b5bd6' : 'inset -3px -3px 0 #7b7b7b, inset 3px 3px 0 #ffffff'
        });
        const a = fb(this.state.fSlot === 0), o = fb(this.state.fSlot === 1), t = fb(this.state.fSlot === 2), r = fb(this.state.fSlot === 3);
        return {
          liveRows: rows.live, queuedRows: rows.queued, endedRows: rows.ended,
          queueEmpty: rows.queued.length === 0,
          ledgerCount: LIVE.length + QUEUED.length + (this.market || []).reduce((x, m) => x + m.sales.length, 0),
          wideCell: this.state.narrow ? 'none' : 'table-cell',
          fAllBg: a.bg, fAllFg: a.fg, fAllSh: a.sh,
          f1Bg: o.bg, f1Fg: o.fg, f1Sh: o.sh,
          f2Bg: t.bg, f2Fg: t.fg, f2Sh: t.sh,
          f3Bg: r.bg, f3Fg: r.fg, f3Sh: r.sh,
          filtAll: () => this.setState({ fSlot: 0 }),
          filt1: () => this.setState({ fSlot: 1 }),
          filt2: () => this.setState({ fSlot: 2 }),
          filt3: () => this.setState({ fSlot: 3 })
        };
      })(),
      pickMkt1: () => this.setState({ mkt: 0 }),
      pickMkt2: () => this.setState({ mkt: 1 }),
      pickMkt3: () => this.setState({ mkt: 2 }),
      setR12: () => this.setState({ range: 12 }),
      setR24: () => this.setState({ range: 24 }),
      setR48: () => this.setState({ range: 48 }),
      setR120: () => this.setState({ range: 120 }),
      expand: () => this.setState({ expanded: true })
    });
  }

  renderVals() {
    const { now, t0, slot, durIdx } = this.state;
    const total1 = 6 * 3600e3;
    const end1 = t0 + 2 * 3600e3 + 47 * 60e3 + 12e3;
    const rem1 = Math.max(0, end1 - now);
    const end2 = t0 + 41 * 60e3 + 6e3;
    const rem2 = Math.max(0, end2 - now);

    const s = SLOTS[slot];
    const d = DURS[durIdx];
    const eff = ask(slot);
    const total = eff * d.h;
    const rem = slot === 0 ? rem1 : (slot === 1 ? rem2 : 0);
    const aheadMs = s.ahead.reduce((x, y) => x + y, 0) * 3600e3;
    const startMs = now + rem + aheadMs;
    const endMs = startMs + d.h * 3600e3;
    const stamp = (ms) => {
      const dd = new Date(ms);
      return this.time(dd) + (dd.getDate() !== new Date(now).getDate() ? ' tomorrow' : '');
    };
    const nd = new Date(now);

    const btn = (i) => ({
      bg: slot === i ? '#000080' : '#c6c6c6',
      fg: slot === i ? '#ffffff' : '#000000',
      sh: slot === i
        ? 'inset 3px 3px 0 #00003f, inset -3px -3px 0 #5b5bd6'
        : 'inset -3px -3px 0 #7b7b7b, inset 3px 3px 0 #ffffff'
    });
    const a = btn(0), b = btn(1), c = btn(2);
    const dbtn = (i) => ({
      bg: durIdx === i ? '#000080' : '#c6c6c6',
      fg: durIdx === i ? '#ffffff' : '#000000',
      sh: durIdx === i ? 'inset 3px 3px 0 #00003f, inset -3px -3px 0 #5b5bd6' : 'inset -3px -3px 0 #7b7b7b, inset 3px 3px 0 #ffffff'
    });

    return {
      c1h: this.pad(rem1 / 3600e3),
      c1m: this.pad((rem1 / 60e3) % 60),
      c1s: this.pad((rem1 / 1000) % 60),
      pct1: Math.max(0, Math.round((rem1 / total1) * 100)),
      paidThrough1: this.time(new Date(end1)),
      expires1: this.time(new Date(end1)),
      c2: this.pad(rem2 / 3600e3) + ':' + this.pad((rem2 / 60e3) % 60) + ':' + this.pad((rem2 / 1000) % 60),
      clock: this.time(nd).replace(/ /, ':' + this.pad(nd.getSeconds()) + ' '),
      openPrice: money(SLOTS[2].rate),
      ...this.marketVals(),
      odometer: React.createElement(HitCounter, { value: this.state.visits, size: 22, pad: 7, roll: !this.reduced }),
      online: String(Math.max(0, this.state.online)).padStart(3, '0'),
      postViews: this.state.views.toLocaleString('en-US'),
      postClicks: this.state.clicks.toLocaleString('en-US'),
      durIdx,
      durLabel: d.h + 'H',
      durName: d.name,
      endLabel: stamp(endMs),
      rate: money(eff),
      total: money(total),
      lineItem: d.h + 'H AT $' + money(eff) + '/HR',
      derivation: '$' + money(s.rate) + ' BASE \u00d7 ' + s.surge.toFixed(1) + ' SURGE \u00d7 ' + d.h + 'H',
      startsLine: s.queue > 0 ? ordinal(s.queue + 1).toUpperCase() + ' IN LINE' : 'IMMEDIATELY',
      queued: s.queue > 0,
      openNow: s.queue === 0,
      posLabel: ordinal(s.queue + 1),
      startLabel: stamp(startMs),
      holderPaid: '$' + money(6 * ask(0)),
      nextExpiry: this.time(new Date(Math.min(end1, end2))),
      waitingTotal: SLOTS.reduce((x, sl) => x + sl.queue, 0),
      surgeOn: s.surge > 1.05,
      surgeLine: s.surge > 1.05 ? 'SURGE ' + s.surge + '\u00d7' : 'SURGE (NONE)',
      surgeColor: '#000000',
      surgeNote: s.note,
      slotLabel: 'SLOT 0' + (slot + 1),
      receiptNo: '0' + (4820 + durIdx + slot * 7),
      slot1Bg: a.bg, slot1Fg: a.fg, slot1Sh: a.sh,
      slot2Bg: b.bg, slot2Fg: b.fg, slot2Sh: b.sh,
      slot3Bg: c.bg, slot3Fg: c.fg, slot3Sh: c.sh,
      buyOpen: this.state.modal === 'buy',
      pricingOpen: this.state.modal === 'pricing',
      openBuy: () => this.setState({ modal: 'buy' }),
      openPricing: () => this.setState({ modal: 'pricing' }),
      closeModal: () => this.setState({ modal: null }),
      fHandle: this.state.fHandle,
      fPlatform: this.state.fPlatform,
      fPitch: this.state.fPitch,
      fUrl: this.state.fUrl,
      fName: this.state.fName,
      isWeb: this.state.fPlatform === 'Website',
      isHandle: this.state.fPlatform !== 'Website',
      handlePrefix: (PLATFORMS[this.state.fPlatform] || {}).prefix || '',
      handlePlaceholder: (PLATFORMS[this.state.fPlatform] || {}).eg || '',
      derivedUrl: ((PLATFORMS[this.state.fPlatform] || {}).prefix || '') + (this.state.fHandle.trim().replace(/^@/, '') || (PLATFORMS[this.state.fPlatform] || {}).eg || ''),
      pitchLeft: 60 - this.state.fPitch.length,
      nameLeft: 24 - this.state.fName.length,
      formError: !!this.state.err,
      errorMsg: this.state.err,
      onHandle: (e) => this.setState({ fHandle: e.target.value }),
      onPlatform: (e) => this.setState({ fPlatform: e.target.value }),
      onPitch: (e) => this.setState({ fPitch: e.target.value.slice(0, 60) }),
      onUrl: (e) => this.setState({ fUrl: e.target.value }),
      onName: (e) => this.setState({ fName: e.target.value.slice(0, 24) }),
      submitBuy: () => {
        const s = this.state;
        let err = '';
        const web = s.fPlatform === 'Website';
        if (web && !s.fUrl.trim()) err = 'Add the URL the listing points to.';
        else if (web && !s.fName.trim()) err = 'Add a display name — 24 characters, no more.';
        else if (!web && !s.fHandle.trim()) err = 'Add your ' + s.fPlatform + ' handle. The link is built from it.';
        else if (!s.fPitch.trim()) err = 'Add one line of copy — 60 characters, no more.';
        this.setState({ err: err });
      },
      d0Bg: dbtn(0).bg, d0Fg: dbtn(0).fg, d0Sh: dbtn(0).sh,
      d1Bg: dbtn(1).bg, d1Fg: dbtn(1).fg, d1Sh: dbtn(1).sh,
      d2Bg: dbtn(2).bg, d2Fg: dbtn(2).fg, d2Sh: dbtn(2).sh,
      d3Bg: dbtn(3).bg, d3Fg: dbtn(3).fg, d3Sh: dbtn(3).sh,
      d4Bg: dbtn(4).bg, d4Fg: dbtn(4).fg, d4Sh: dbtn(4).sh,
      setD0: () => this.setState({ durIdx: 0 }),
      setD1: () => this.setState({ durIdx: 1 }),
      setD2: () => this.setState({ durIdx: 2 }),
      setD3: () => this.setState({ durIdx: 3 }),
      setD4: () => this.setState({ durIdx: 4 }),
      setSlot1: () => this.setState({ slot: 0 }),
      setSlot2: () => this.setState({ slot: 1 }),
      setSlot3: () => this.setState({ slot: 2 }),
      pickOpen: () => this.setState({ slot: 2 }),
      onDur: (e) => this.setState({ durIdx: Number(e.target.value) })
    };
  }
}

