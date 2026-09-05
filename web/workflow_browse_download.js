/**
 * ワークフローブラウズの右クリックメニューに「ダウンロード」を追加する。
 * 選択したワークフローの JSON ファイルを保存する。
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MENU_ITEM_CLASS = "comfy-workflow-browse-download";
const BROWSE_SELECTOR =
  ".comfyui-workflows-browse, .comfyui-workflows-search-panel";

/** ComfyUI の i18n から翻訳を取得する。未定義なら fallback を返す。 */
function t(key, fallback) {
  const vueApp =
    app.vueApp ||
    document.querySelector("#vue-app")?.__vue_app__ ||
    document.querySelector("#app")?.__vue_app__;
  const i18n = vueApp?.config?.globalProperties?.$t;
  if (typeof i18n === "function") {
    const value = i18n(key);
    if (value && value !== key) {
      return value;
    }
  }
  if (
    key === "g.download" &&
    (document.documentElement.lang || "").startsWith("ja")
  ) {
    return "ダウンロード";
  }
  return fallback;
}

/** トーストがあればエラーを表示し、なければ console.error に出す。 */
function showError(message) {
  const toast = app.extensionManager?.toast;
  if (toast?.add) {
    toast.add({
      severity: "error",
      summary: message,
      life: 4000,
    });
    return;
  }
  console.error(message);
}

/** 要素がワークフローブラウズまたは検索パネル内かどうかを返す。 */
function isBrowseTarget(el) {
  return Boolean(el?.closest?.(BROWSE_SELECTOR));
}

/** DOM を親方向に辿り、Vue ツリーノード（props.node）を探す。 */
function getTreeNodeFromElement(el) {
  let current = el instanceof Element ? el : el?.parentElement;
  while (current) {
    const node = current.__vueParentComponent?.props?.node;
    if (node?.data) {
      return node;
    }
    current = current.parentElement;
  }
  return null;
}

/** ワークフローキーから `.json` / `.app.json` を除く。 */
function stripWorkflowSuffix(path) {
  return String(path || "").replace(/\.(app\.)?json$/i, "");
}

/** ツリー上のラベルを辿り、ルートからの相対パスを組み立てる。 */
function relativeKeyFromDom(el) {
  const parts = [];
  const root = el.closest(BROWSE_SELECTOR);
  let node = el.closest(".p-tree-node");
  while (node && root?.contains(node)) {
    const label = node
      .querySelector(":scope > .p-tree-node-content .node-label")
      ?.textContent?.trim();
    if (label) {
      parts.unshift(label);
    }
    const parent = node.parentElement?.closest(".p-tree-node");
    if (!parent || parent === node) {
      break;
    }
    node = parent;
  }
  return parts.join("/");
}

/** 保存済みワークフロー一覧をストアから取得する。 */
function workflowsFromStore() {
  return app.extensionManager?.workflow?.persistedWorkflows || [];
}

/** 相対キーに一致する保存済みワークフローを返す。 */
function matchWorkflowByKey(relativeKey) {
  if (!relativeKey) {
    return null;
  }
  return (
    workflowsFromStore().find(
      (workflow) => stripWorkflowSuffix(workflow.key) === relativeKey
    ) || null
  );
}

/**
 * 右クリック対象から保存済みワークフローを特定する。
 * Vue ノードが取れない場合は DOM 上のパスでストアと照合する。
 */
function resolveWorkflow(event) {
  const target = event.target;
  if (!(target instanceof Element) || !isBrowseTarget(target)) {
    return null;
  }
  if (!target.closest(".tree-leaf")) {
    return null;
  }

  const treeNode = getTreeNodeFromElement(target);
  if (treeNode) {
    const workflow = treeNode.data;
    if (workflow?.path && !workflow.isTemporary) {
      return { treeNode, workflow };
    }
  }

  const workflow = matchWorkflowByKey(relativeKeyFromDom(target));
  if (!workflow) {
    return null;
  }
  return { treeNode, workflow };
}

/** ダウンロード時のファイル名をワークフロー情報から決める。 */
function downloadFilename(workflow) {
  return (
    workflow.fullFilename ||
    workflow.path?.split("/").pop() ||
    "workflow.json"
  );
}

/** ユーザーデータ API からワークフロー JSON を取得し、ブラウザで保存する。 */
async function downloadWorkflow(workflow) {
  if (!workflow?.path) {
    return;
  }

  const resp = await api.getUserData(workflow.path);
  if (!resp.ok) {
    throw new Error(
      t("g.download", "Download") + ` failed: ${resp.status}`
    );
  }

  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadFilename(workflow);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** 右クリックメニューに追加する「ダウンロード」項目を作る。 */
function makeMenuItem(workflow) {
  return {
    label: t("g.download", "Download"),
    icon: "pi pi-download",
    visible: true,
    class: MENU_ITEM_CLASS,
    command: async () => {
      try {
        await downloadWorkflow(workflow);
      } catch (err) {
        showError(err?.message || String(err));
      }
    },
  };
}

/** Vue ツリーノードの contextMenuItems にダウンロード項目を差し込む。 */
function patchNodeMenu(treeNode, workflow) {
  if (!treeNode || treeNode.__comfyDownloadPatched) {
    return;
  }

  const original = treeNode.contextMenuItems;
  treeNode.contextMenuItems = (node) => {
    const items =
      typeof original === "function"
        ? original.call(treeNode, node) || []
        : [...(original || [])];
    if (!items.some((item) => item?.class === MENU_ITEM_CLASS)) {
      items.push(makeMenuItem(workflow));
    }
    return items;
  };
  treeNode.__comfyDownloadPatched = true;
}

/** 画面上に表示中の PrimeVue コンテキストメニュー要素を返す。 */
function visibleContextMenus() {
  return [...document.querySelectorAll(".p-contextmenu")].filter((menu) => {
    const style = getComputedStyle(menu);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      menu.offsetParent !== null
    );
  });
}

/** Vue 側をパッチできないとき、表示中メニューへ DOM で項目を注入する。 */
function injectDomMenuItem(workflow) {
  for (const menu of visibleContextMenus()) {
    if (menu.querySelector(`.${MENU_ITEM_CLASS}`)) {
      continue;
    }

    const items = menu.querySelectorAll(
      ".p-contextmenu-item, [data-pc-section='item']"
    );
    const template = items[items.length - 1];
    if (!template) {
      continue;
    }

    const clone = template.cloneNode(true);
    clone.classList.add(MENU_ITEM_CLASS);
    clone.querySelectorAll("[class*='highlight'], .p-focus").forEach((el) => {
      el.classList.remove("p-focus", "p-highlight");
    });

    const label =
      clone.querySelector(".p-contextmenu-item-label") ||
      clone.querySelector("[data-pc-section='itemlabel']");
    if (label) {
      label.textContent = t("g.download", "Download");
    }

    const icon =
      clone.querySelector(".p-contextmenu-item-icon") ||
      clone.querySelector("[data-pc-section='itemicon']");
    if (icon) {
      icon.className = icon.className
        .split(/\s+/)
        .filter((cls) => !cls.startsWith("pi-") && cls !== "pi")
        .concat(["pi", "pi-download"])
        .join(" ");
    }

    clone.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await downloadWorkflow(workflow);
      } catch (err) {
        showError(err?.message || String(err));
      }
    });

    template.parentElement.appendChild(clone);
  }
}

/** ブラウズ上の右クリックを受け、メニューへダウンロード項目を足す。 */
function onContextMenu(event) {
  const resolved = resolveWorkflow(event);
  if (!resolved) {
    return;
  }

  if (resolved.treeNode) {
    patchNodeMenu(resolved.treeNode, resolved.workflow);
    return;
  }

  requestAnimationFrame(() => {
    injectDomMenuItem(resolved.workflow);
  });
}

app.registerExtension({
  name: "ComfyUI.WorkflowBrowseDownload",
  setup() {
    document.addEventListener("contextmenu", onContextMenu, true);
  },
});
