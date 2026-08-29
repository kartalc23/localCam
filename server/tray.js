/* Sistem tepsisi (StatusNotifierItem + dbusmenu).
   Barlarda localCam ikonu gorunur; renk baglanti durumunu gosterir. */
import dbus from "dbus-next";
import { drawIcon, toArgb, ICON_COLORS } from "./icon.js";

const { Variant } = dbus;
const { Interface, ACCESS_READ } = dbus.interface;

const ICON_SIZES = [22, 32, 48];
const WATCHER = "org.kde.StatusNotifierWatcher";

const pixmapsFor = (state) =>
  ICON_SIZES.map((s) => [s, s, toArgb(drawIcon(s, ICON_COLORS[state] || ICON_COLORS.idle))]);

// -------------------------------------------------------------- dbusmenu --

const SEPARATOR = { type: "separator" };

class MenuInterface extends Interface {
  constructor(tray) {
    super("com.canonical.dbusmenu");
    this.tray = tray;
    this.revision = 1;
  }

  get Version() { return 3; }
  get TextDirection() { return "ltr"; }
  get Status() { return "normal"; }
  get IconThemePath() { return []; }

  #entries() {
    return this.tray.menuItems();
  }

  #itemVariant(id, item) {
    const props = {};
    if (item.type === "separator") {
      props.type = new Variant("s", "separator");
    } else {
      props.label = new Variant("s", item.label);
      props.enabled = new Variant("b", item.enabled !== false);
      props.visible = new Variant("b", item.visible !== false);
    }
    return new Variant("(ia{sv}av)", [id, props, []]);
  }

  GetLayout(parentId, _depth, _propertyNames) {
    const children = this.#entries().map((item, i) => this.#itemVariant(i + 1, item));
    const root = [0, { "children-display": new Variant("s", "submenu") }, parentId === 0 ? children : []];
    return [this.revision, root];
  }

  GetGroupProperties(ids, _propertyNames) {
    const entries = this.#entries();
    const wanted = ids.length ? ids : entries.map((_, i) => i + 1);
    return wanted
      .filter((id) => entries[id - 1])
      .map((id) => {
        const v = this.#itemVariant(id, entries[id - 1]).value;
        return [id, v[1]];
      });
  }

  GetProperty(id, name) {
    const item = this.#entries()[id - 1];
    if (!item) return new Variant("s", "");
    return this.#itemVariant(id, item).value[1][name] || new Variant("s", "");
  }

  Event(id, eventId, _data, _timestamp) {
    if (eventId !== "clicked") return;
    this.#entries()[id - 1]?.action?.();
  }

  EventGroup(events) {
    for (const [id, eventId, data, ts] of events) this.Event(id, eventId, data, ts);
    return [];
  }

  AboutToShow(_id) { return false; }
  AboutToShowGroup(_ids) { return [[], []]; }

  /** Menu icerigi degisince barin yeniden sormasini saglar. */
  refresh() {
    this.revision++;
    this.LayoutUpdated(this.revision, 0);
  }

  LayoutUpdated(revision, parent) { return [revision, parent]; }
  ItemsPropertiesUpdated(updated, removed) { return [updated, removed]; }
  ItemActivationRequested(id, timestamp) { return [id, timestamp]; }
}

MenuInterface.configureMembers({
  properties: {
    Version: { signature: "u", access: ACCESS_READ },
    TextDirection: { signature: "s", access: ACCESS_READ },
    Status: { signature: "s", access: ACCESS_READ },
    IconThemePath: { signature: "as", access: ACCESS_READ },
  },
  methods: {
    GetLayout: { inSignature: "iias", outSignature: "u(ia{sv}av)" },
    GetGroupProperties: { inSignature: "aias", outSignature: "a(ia{sv})" },
    GetProperty: { inSignature: "is", outSignature: "v" },
    Event: { inSignature: "isvu", outSignature: "" },
    EventGroup: { inSignature: "a(isvu)", outSignature: "ai" },
    AboutToShow: { inSignature: "i", outSignature: "b" },
    AboutToShowGroup: { inSignature: "ai", outSignature: "aiai" },
  },
  signals: {
    LayoutUpdated: { signature: "ui" },
    ItemsPropertiesUpdated: { signature: "a(ia{sv})a(ias)" },
    ItemActivationRequested: { signature: "iu" },
  },
});

// -------------------------------------------------- StatusNotifierItem --

class ItemInterface extends Interface {
  constructor(tray) {
    super("org.kde.StatusNotifierItem");
    this.tray = tray;
  }

  get Category() { return "Hardware"; }
  get Id() { return "localcam"; }
  get Title() { return "localCam"; }
  get Status() { return this.tray.state === "live" ? "Active" : "Passive"; }
  get WindowId() { return 0; }
  get IconName() { return ""; }
  get IconPixmap() { return pixmapsFor(this.tray.state); }
  get OverlayIconName() { return ""; }
  get OverlayIconPixmap() { return []; }
  get AttentionIconName() { return ""; }
  get AttentionIconPixmap() { return []; }
  get AttentionMovieName() { return ""; }
  get ToolTip() { return ["", [], "localCam", this.tray.tooltip]; }
  get ItemIsMenu() { return false; }
  get Menu() { return "/MenuBar"; }

  Activate(_x, _y) { this.tray.opts.onActivate?.(); }
  SecondaryActivate(_x, _y) { this.tray.opts.onActivate?.(); }
  ContextMenu(_x, _y) {}
  Scroll(_delta, _orientation) {}

  NewIcon() {}
  NewStatus(status) { return status; }
  NewToolTip() {}
  NewTitle() {}
}

ItemInterface.configureMembers({
  properties: {
    Category: { signature: "s", access: ACCESS_READ },
    Id: { signature: "s", access: ACCESS_READ },
    Title: { signature: "s", access: ACCESS_READ },
    Status: { signature: "s", access: ACCESS_READ },
    WindowId: { signature: "i", access: ACCESS_READ },
    IconName: { signature: "s", access: ACCESS_READ },
    IconPixmap: { signature: "a(iiay)", access: ACCESS_READ },
    OverlayIconName: { signature: "s", access: ACCESS_READ },
    OverlayIconPixmap: { signature: "a(iiay)", access: ACCESS_READ },
    AttentionIconName: { signature: "s", access: ACCESS_READ },
    AttentionIconPixmap: { signature: "a(iiay)", access: ACCESS_READ },
    AttentionMovieName: { signature: "s", access: ACCESS_READ },
    ToolTip: { signature: "(sa(iiay)ss)", access: ACCESS_READ },
    ItemIsMenu: { signature: "b", access: ACCESS_READ },
    Menu: { signature: "o", access: ACCESS_READ },
  },
  methods: {
    Activate: { inSignature: "ii", outSignature: "" },
    SecondaryActivate: { inSignature: "ii", outSignature: "" },
    ContextMenu: { inSignature: "ii", outSignature: "" },
    Scroll: { inSignature: "is", outSignature: "" },
  },
  signals: {
    NewIcon: { signature: "" },
    NewStatus: { signature: "s" },
    NewToolTip: { signature: "" },
    NewTitle: { signature: "" },
  },
});

// ------------------------------------------------------------------ Tray --

export class Tray {
  constructor(opts = {}) {
    this.opts = opts;
    this.state = "idle";
    this.tooltip = "iPhone bekleniyor";
    this.bus = null;
    this.item = null;
    this.menu = null;
    this.retry = null;
  }

  menuItems() {
    const connected = this.state === "live";
    return [
      { label: this.tooltip, enabled: false },
      SEPARATOR,
      { label: "Baglanti sayfasini ac", action: () => this.opts.onActivate?.() },
      { label: "Telefon linkini kopyala", action: () => this.opts.onCopy?.() },
      { label: "Yayini durdur", enabled: connected, action: () => this.opts.onStop?.() },
      SEPARATOR,
      { label: "localCam'i kapat", action: () => this.opts.onQuit?.() },
    ];
  }

  async start() {
    this.bus = dbus.sessionBus();
    const name = `org.kde.StatusNotifierItem-${process.pid}-1`;
    await this.bus.requestName(name, 0);

    this.item = new ItemInterface(this);
    this.menu = new MenuInterface(this);
    this.bus.export("/StatusNotifierItem", this.item);
    this.bus.export("/MenuBar", this.menu);
    this.name = name;

    await this.#register();
    await this.#watchForWatcher();
  }

  async #register() {
    try {
      const obj = await this.bus.getProxyObject(WATCHER, "/StatusNotifierWatcher");
      await obj.getInterface(WATCHER).RegisterStatusNotifierItem(this.name);
      return true;
    } catch {
      return false; // bar henuz acilmamis olabilir
    }
  }

  /** Bar sonradan acilirsa/yeniden baslarsa ikonu tekrar kaydet. */
  async #watchForWatcher() {
    const obj = await this.bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus");
    const iface = obj.getInterface("org.freedesktop.DBus");
    iface.on("NameOwnerChanged", (busName, _old, newOwner) => {
      if (busName === WATCHER && newOwner) setTimeout(() => this.#register(), 500);
    });
  }

  setState(state, tooltip) {
    const changed = state !== this.state;
    this.state = state;
    if (tooltip) this.tooltip = tooltip;
    if (!this.item) return;
    try {
      if (changed) {
        this.item.NewIcon();
        this.item.NewStatus(state === "live" ? "Active" : "Passive");
      }
      this.item.NewToolTip();
      this.menu?.refresh();
    } catch { /* bar kapanmis olabilir */ }
  }

  async stop() {
    clearTimeout(this.retry);
    try { this.bus?.disconnect(); } catch { /* zaten kapali */ }
  }
}
