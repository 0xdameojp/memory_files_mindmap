
import {
  FormEvent,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useState,
  useTransition,
  type MouseEvent,
  type WheelEvent,
} from "react";

import type { MindMapNode } from "../../shared/types";

type DriveMindMapProps = {
  initialSignedIn: boolean;
  initialError?: string;
};

type MindMapTheme = "classic" | "light";

type PositionedNode = {
  id: string;
  name: string;
  type: MindMapNode["type"];
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
  imageCount: number;
  imageUrl?: string;
  mimeType?: string;
  webViewLink?: string;
};

type Edge = {
  from: string;
  to: string;
};

type GraphLayout = {
  nodes: PositionedNode[];
  edges: Edge[];
  width: number;
  height: number;
};

type ViewportTier = "mobile" | "desktop";

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 820;
const FOLDER_WIDTH = 132;
const FOLDER_HEIGHT = 118;
const IMAGE_WIDTH = 112;
const IMAGE_HEIGHT = 98;
const MOBILE_NODE_LIMIT = 60;

function countFolders(node: MindMapNode): number {
  return (
    1 +
    node.children
      .filter((child) => child.type === "folder")
      .reduce((sum, child) => sum + countFolders(child), 0)
  );
}

function extractFolderId(input: string) {
  const trimmed = input.trim();

  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    const folderMatch = url.pathname.match(/\/folders\/([^/?]+)/);

    if (folderMatch?.[1]) {
      return folderMatch[1];
    }

    return url.searchParams.get("id") ?? trimmed;
  } catch {
    return trimmed;
  }
}

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function findNodeByPath(tree: MindMapNode, path: string[]) {
  let current = tree;

  for (const nodeId of path) {
    const nextNode = current.children.find(
      (child) => child.type === "folder" && child.id === nodeId,
    );

    if (!nextNode) {
      return tree;
    }

    current = nextNode;
  }

  return current;
}

function buildBreadcrumbs(tree: MindMapNode, path: string[]) {
  const crumbs = [{ id: tree.id, name: tree.name, path: [] as string[] }];
  let current = tree;
  const walkedPath: string[] = [];

  for (const nodeId of path) {
    const nextNode = current.children.find(
      (child) => child.type === "folder" && child.id === nodeId,
    );

    if (!nextNode) {
      break;
    }

    walkedPath.push(nodeId);
    crumbs.push({
      id: nextNode.id,
      name: nextNode.name,
      path: [...walkedPath],
    });
    current = nextNode;
  }

  return crumbs;
}

function createLayout(
  currentFolder: MindMapNode,
  zoom: number,
  viewportTier: ViewportTier,
): GraphLayout {
  const nodes: PositionedNode[] = [];
  const edges: Edge[] = [];

  const sortedChildren = [...currentFolder.children].sort((left, right) =>
    left.name.localeCompare(right.name, "ja"),
  );
  const children =
    viewportTier === "mobile"
      ? sortedChildren.slice(0, MOBILE_NODE_LIMIT)
      : sortedChildren;

  if (children.length === 0) {
    return {
      nodes,
      edges,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
    };
  }

  const orbitCenterX = CANVAS_WIDTH / 2;
  const orbitCenterY = CANVAS_HEIGHT / 2;
  const zoomProgress = (zoom - 0.55) / (3 - 0.55);
  const spreadScale = 0.72 + zoomProgress * 1.1;
  const nodeScale = 0.86 + zoomProgress * 0.34;
  const maxRadius = Math.min(
    Math.min(CANVAS_WIDTH, CANVAS_HEIGHT) * 0.42,
    220 + children.length * 4.8,
  ) * spreadScale;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  children.forEach((child, index) => {
    const hash = hashString(child.id);
    const normalizedIndex = (index + 0.5) / Math.max(children.length, 1);
    const angle = index * goldenAngle + (hash % 17) * 0.015;
    const radialOffset = ((hash % 29) - 14) * 3.2;
    const radius = Math.max(
      18,
      Math.sqrt(normalizedIndex) * maxRadius + radialOffset,
    );
    const width = Math.round(
      (child.type === "folder" ? FOLDER_WIDTH : IMAGE_WIDTH) * nodeScale,
    );
    const height = Math.round(
      (child.type === "folder" ? FOLDER_HEIGHT : IMAGE_HEIGHT) * nodeScale,
    );
    const jitterX = ((hash >> 3) % 19) - 9;
    const jitterY = ((hash >> 5) % 19) - 9;

    nodes.push({
      id: child.id,
      name: child.name,
      type: child.type,
      x: orbitCenterX + Math.cos(angle) * radius + jitterX - width / 2,
      y: orbitCenterY + Math.sin(angle) * radius + jitterY - height / 2,
      width,
      height,
      level: 0,
      imageCount: child.imageCount,
      imageUrl: child.imageUrl,
      mimeType: child.mimeType,
      webViewLink: child.webViewLink,
    });
  });

  return {
    nodes,
    edges,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  };
}

function GraphCanvas({
  currentFolder,
  onEnterFolder,
  onSelectImage,
  theme,
  zoom,
  viewportTier,
}: {
  currentFolder: MindMapNode;
  onEnterFolder: (folderId: string) => void;
  onSelectImage: (event: MouseEvent<HTMLButtonElement>, node: PositionedNode) => void;
  theme: MindMapTheme;
  zoom: number;
  viewportTier: ViewportTier;
}) {
  const layout = useMemo(
    () => createLayout(currentFolder, zoom, viewportTier),
    [currentFolder, viewportTier, zoom],
  );
  const nodeMap = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  );

  return (
    <div
      className={`mindmap-stage mindmap-stage-${theme}`}
      style={{
        width: layout.width,
        height: layout.height,
      }}
    >
      <svg
        className="mindmap-links"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        aria-hidden="true"
      >
        {layout.edges.map((edge) => {
          const fromNode = nodeMap.get(edge.from);
          const toNode = nodeMap.get(edge.to);

          if (!fromNode || !toNode) {
            return null;
          }

          const startX = fromNode.x + fromNode.width / 2;
          const startY = fromNode.y + fromNode.height / 2;
          const endX = toNode.x + toNode.width / 2;
          const endY = toNode.y + toNode.height / 2;
          const controlOffset = Math.max(Math.abs(endX - startX) * 0.22, 36);

          return (
            <path
              key={`${edge.from}-${edge.to}`}
              d={`M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`}
            />
          );
        })}
      </svg>

      {layout.nodes.map((node) => {
        if (node.type === "folder") {
          return (
            <button
              key={node.id}
              className={[
                "mindmap-node",
                "mindmap-folder",
                `mindmap-folder-${theme}`,
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
              }}
              onClick={() => onEnterFolder(node.id)}
              type="button"
            >
              <div className="mindmap-folder-dot" />
              <div className="mindmap-copy">
                <h3>{node.name}</h3>
                <p>{node.imageCount} images</p>
              </div>
              <span className="mindmap-folder-action">Open</span>
            </button>
          );
        }

        return (
          <button
            key={node.id}
            className={`mindmap-node mindmap-image mindmap-image-${theme}`}
            style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
            onClick={(event) => onSelectImage(event, node)}
            type="button"
          >
            <span className="mindmap-thumb">
              {node.imageUrl ? (
                <img
                  src={node.imageUrl}
                  alt={node.name}
                  className="fill-image"
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ImageDialog({
  image,
  onClose,
  theme,
}: {
  image: PositionedNode | null;
  onClose: () => void;
  theme: MindMapTheme;
}) {
  if (!image) {
    return null;
  }

  return (
    <div
      className={`image-dialog-backdrop image-dialog-backdrop-${theme}`}
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`image-dialog image-dialog-${theme}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={image.name}
      >
        <button className="image-dialog-close" onClick={onClose} type="button">
          Close
        </button>
        <div className="image-dialog-frame">
          {image.imageUrl ? (
            <img
              src={image.imageUrl}
              alt={image.name}
              className="fill-image"
              decoding="async"
            />
          ) : null}
        </div>
        <div className="image-dialog-meta">
          <h3>{image.name}</h3>
          {image.webViewLink ? (
            <a href={image.webViewLink} rel="noreferrer" target="_blank">
              Google Drive で開く
            </a>
          ) : (
            <p>{image.mimeType}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function DriveMindMap({
  initialSignedIn,
  initialError,
}: DriveMindMapProps) {
  const MIN_ZOOM = 0.55;
  const MAX_ZOOM = 3;
  const ZOOM_STEP = 0.15;
  const [signedIn, setSignedIn] = useState(initialSignedIn);
  const [folderInput, setFolderInput] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return window.localStorage.getItem("drive-folder-input") ?? "";
  });
  const [tree, setTree] = useState<MindMapNode | null>(null);
  const [currentPath, setCurrentPath] = useState<string[]>([]);
  const [selectedImage, setSelectedImage] = useState<PositionedNode | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewportTier, setViewportTier] = useState<ViewportTier>("desktop");
  const hasAttemptedInitialLoadRef = useRef(false);
  const mapScrollRef = useRef<HTMLDivElement | null>(null);
  const mouseDragSessionRef = useRef<{
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const [isDraggingMap, setIsDraggingMap] = useState(false);
  const [theme, setTheme] = useState<MindMapTheme>(() => {
    if (typeof window === "undefined") {
      return "classic";
    }

    const savedTheme = window.localStorage.getItem("mindmap-theme");

    if (savedTheme === "light" || savedTheme === "classic") {
      return savedTheme;
    }

    return "classic";
  });
  const [error, setError] = useState(initialError ?? "");
  const [isPending, startTransition] = useTransition();

  const currentFolder = useMemo(() => {
    if (!tree) {
      return null;
    }

    return findNodeByPath(tree, currentPath);
  }, [currentPath, tree]);

  const breadcrumbs = useMemo(() => {
    if (!tree) {
      return [];
    }

    return buildBreadcrumbs(tree, currentPath);
  }, [currentPath, tree]);

  const stats = useMemo(() => {
    if (!tree || !currentFolder) {
      return null;
    }

    const directFolders = currentFolder.children.filter(
      (child) => child.type === "folder",
    ).length;
    const directImages = currentFolder.children.filter(
      (child) => child.type === "image",
    ).length;

    return {
      folders: countFolders(tree),
      images: tree.imageCount,
      directFolders,
      directImages,
    };
  }, [currentFolder, tree]);

  const loadDriveTree = (folderId: string) => {
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/drive/tree?folderId=${encodeURIComponent(folderId)}`,
        );
        const data = (await response.json()) as {
          tree?: MindMapNode;
          error?: string;
        };

        if (!response.ok || !data.tree) {
          throw new Error(data.error ?? "Drive フォルダの読み込みに失敗しました。");
        }

        setTree(data.tree);
        setCurrentPath([]);
        setSelectedImage(null);
        setZoom(1);
        setSignedIn(true);
        setError("");
      } catch (caughtError) {
        setTree(null);
        setCurrentPath([]);
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Drive フォルダの読み込みに失敗しました。",
        );
      }
    });
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const updateViewportTier = () => {
      setViewportTier(window.innerWidth <= 768 ? "mobile" : "desktop");
    };

    updateViewportTier();
    window.addEventListener("resize", updateViewportTier);

    return () => window.removeEventListener("resize", updateViewportTier);
  }, []);

  useEffect(() => {
    if (!signedIn || tree || hasAttemptedInitialLoadRef.current) {
      return;
    }

    hasAttemptedInitialLoadRef.current = true;
    loadDriveTree("root");
  }, [signedIn, tree]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const folderId = extractFolderId(folderInput);

    if (!folderId) {
      setError("Google Drive のフォルダ URL かフォルダ ID を入力してください。");
      return;
    }

    window.localStorage.setItem("drive-folder-input", folderInput);
    setError("");
    hasAttemptedInitialLoadRef.current = true;
    loadDriveTree(folderId);
  };

  const handleLogout = async () => {
    await fetch("/api/auth/google/logout", { method: "POST" });
    setSignedIn(false);
    setTree(null);
    setCurrentPath([]);
    setSelectedImage(null);
    setZoom(1);
    hasAttemptedInitialLoadRef.current = false;
  };

  const handleThemeChange = (nextTheme: MindMapTheme) => {
    setTheme(nextTheme);
    window.localStorage.setItem("mindmap-theme", nextTheme);
  };

  const handleEnterFolder = (folderId: string) => {
    setCurrentPath((previousPath) => [...previousPath, folderId]);
    setSelectedImage(null);
  };

  const handleJumpTo = (path: string[]) => {
    setCurrentPath(path);
    setSelectedImage(null);
  };

  const adjustZoom = (delta: number) => {
    setZoom((currentZoom) =>
      Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number((currentZoom + delta).toFixed(2)))),
    );
  };

  const isInteractiveTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    target.closest(
      ".mindmap-node, .map-overlay, button, a, input, label, textarea, select",
    );

  const handleWheelZoom = (event: WheelEvent<HTMLDivElement>) => {
    const target = event.target;

    if (
      target instanceof HTMLElement &&
      target.closest("input, textarea, select")
    ) {
      return;
    }

    event.preventDefault();
    adjustZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  };

  const centerMapViewport = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = mapScrollRef.current;

    if (!container) {
      return;
    }

    const left = Math.max(0, (CANVAS_WIDTH - container.clientWidth) / 2);
    const top = Math.max(0, (CANVAS_HEIGHT - container.clientHeight) / 2);

    container.scrollTo({ left, top, behavior });
  }, []);

  useEffect(() => {
    if (!currentFolder) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      centerMapViewport();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [centerMapViewport, currentFolder]);

  const resetView = () => {
    setZoom(1);
    window.requestAnimationFrame(() => {
      centerMapViewport("smooth");
    });
  };

  const handleMapMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) {
      return;
    }

    const container = mapScrollRef.current;

    if (!container) {
      return;
    }

    mouseDragSessionRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    };
    setIsDraggingMap(true);
    event.preventDefault();
  };

  const handleMapMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const container = mapScrollRef.current;
    const session = mouseDragSessionRef.current;

    if (!container || !session) {
      return;
    }

    container.scrollLeft = session.scrollLeft - (event.clientX - session.startX);
    container.scrollTop = session.scrollTop - (event.clientY - session.startY);
  };

  const finishMouseDrag = () => {
    mouseDragSessionRef.current = null;
    setIsDraggingMap(false);
  };

  useEffect(() => {
    if (!isDraggingMap) {
      return;
    }

    const handleWindowMouseMove = (event: globalThis.MouseEvent) => {
      const container = mapScrollRef.current;
      const session = mouseDragSessionRef.current;

      if (!container || !session) {
        return;
      }

      container.scrollLeft = session.scrollLeft - (event.clientX - session.startX);
      container.scrollTop = session.scrollTop - (event.clientY - session.startY);
    };

    const handleWindowMouseUp = () => {
      finishMouseDrag();
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [isDraggingMap]);

  const handleImageClick = (_event: MouseEvent<HTMLButtonElement>, node: PositionedNode) => {
    setSelectedImage(node);
  };

  return (
    <div className="page-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">Google Drive Visual Mapper</span>
          <h1>Google Drive の画像を、探索しやすいマップとして表示。</h1>
          <p>
            Obsidian のグラフビューの雰囲気を参考にしつつ、フォルダごとに中身を
            たどっていけるドリルダウン型のビジュアルにしています。フォルダを開き、
            気になる画像はその場でプレビューできます。
          </p>
        </div>

        <div className="hero-actions">
          <div className="theme-switcher" role="tablist" aria-label="Mind map theme">
            <button
              className={`theme-option ${theme === "classic" ? "theme-option-active" : ""}`}
              onClick={() => handleThemeChange("classic")}
              type="button"
            >
              クラシック
            </button>
            <button
              className={`theme-option ${theme === "light" ? "theme-option-active" : ""}`}
              onClick={() => handleThemeChange("light")}
              type="button"
            >
              ライト
            </button>
          </div>
          {signedIn ? (
            <>
              <span className="status-pill status-pill-connected">
                Google 連携済み
              </span>
              <button className="secondary-button" onClick={handleLogout} type="button">
                ログアウト
              </button>
            </>
          ) : (
            <a className="primary-button" href="/api/auth/google/login">
              Google でログイン
            </a>
          )}
        </div>
      </section>

      <section className="control-panel">
        <div>
          <h2>表示するフォルダ</h2>
          <p>
            共有ドライブを含め、認証ユーザーが参照できるフォルダの URL または
            フォルダ ID を入力してください。
          </p>
        </div>

        <form className="folder-form" onSubmit={handleSubmit}>
          <label className="input-label">
            Folder URL / ID
            <input
              value={folderInput}
              onChange={(event) => setFolderInput(event.target.value)}
              placeholder="https://drive.google.com/drive/folders/..."
            />
          </label>
          <button className="primary-button" type="submit" disabled={isPending}>
            {isPending ? "読み込み中..." : "マップを表示"}
          </button>
        </form>

        {error ? <p className="feedback feedback-error">{error}</p> : null}

        {stats ? (
          <div className="stats-grid stats-grid-wide">
            <article>
              <span>Total folders</span>
              <strong>{stats.folders}</strong>
            </article>
            <article>
              <span>Total images</span>
              <strong>{stats.images}</strong>
            </article>
            <article>
              <span>Current folders</span>
              <strong>{stats.directFolders}</strong>
            </article>
            <article>
              <span>Current images</span>
              <strong>{stats.directImages}</strong>
            </article>
          </div>
        ) : null}
      </section>

      <section
        className={`map-panel ${theme === "classic" ? "map-panel-obsidian" : "map-panel-light"}`}
      >
        {tree && currentFolder ? (
          <>
            <div
              className={`map-scroll ${theme === "classic" ? "map-scroll-obsidian" : "map-scroll-light"}`}
              ref={mapScrollRef}
              onWheel={handleWheelZoom}
              onMouseDown={handleMapMouseDown}
              onMouseMove={handleMapMouseMove}
              onMouseUp={finishMouseDrag}
              onMouseLeave={finishMouseDrag}
              data-panning={isDraggingMap}
            >
              <div className="map-overlay">
                <div className="map-directory">
                  <span
                    className={`eyebrow ${theme === "classic" ? "eyebrow-dark" : "eyebrow-light"}`}
                  >
                    Directory
                  </span>
                  <div className="map-directory-meta">
                    <strong>{currentFolder.name}</strong>
                    <span>{currentFolder.children.length} items</span>
                  </div>
                  <p className="map-touch-hint">
                    1本指で移動 / 2本指またはボタンでズーム
                  </p>
                  <div className="breadcrumb-trail" aria-label="Folder breadcrumb">
                    {breadcrumbs.map((crumb, index) => (
                      <button
                        key={`${crumb.id}-${index}`}
                        className={`breadcrumb-chip ${
                          index === breadcrumbs.length - 1 ? "breadcrumb-chip-current" : ""
                        }`}
                        onClick={() => handleJumpTo(crumb.path)}
                        type="button"
                      >
                        {crumb.name}
                      </button>
                    ))}
                  </div>
                  <div className="map-zoom-controls" aria-label="Map zoom controls">
                    <button
                      className="zoom-chip"
                      onClick={() => adjustZoom(-ZOOM_STEP)}
                      type="button"
                      disabled={zoom <= MIN_ZOOM}
                    >
                      -
                    </button>
                    <button
                      className="zoom-chip zoom-chip-current"
                      onClick={resetView}
                      type="button"
                    >
                      Reset
                    </button>
                    <button className="zoom-chip zoom-chip-current" type="button">
                      {Math.round(zoom * 100)}%
                    </button>
                    <button
                      className="zoom-chip"
                      onClick={() => adjustZoom(ZOOM_STEP)}
                      type="button"
                      disabled={zoom >= MAX_ZOOM}
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>
              <GraphCanvas
                currentFolder={currentFolder}
                onEnterFolder={handleEnterFolder}
                onSelectImage={handleImageClick}
                theme={theme}
                zoom={zoom}
                viewportTier={viewportTier}
              />
            </div>
          </>
        ) : (
          <div
            className={`empty-state ${theme === "classic" ? "empty-state-obsidian" : "empty-state-light"}`}
          >
            <span
              className={`eyebrow ${theme === "classic" ? "eyebrow-dark" : "eyebrow-light"}`}
            >
              Ready
            </span>
            <h2>フォルダを読み込むと、ここに球状に広がるビジュアルマップが表示されます。</h2>
            <p>
              まずは Google Drive フォルダを指定してください。左上のディレクトリ表示から
              戻りながら、今のフォルダ直下のアイテムだけを軽く一覧できます。
            </p>
          </div>
        )}
      </section>

      <ImageDialog
        image={selectedImage}
        onClose={() => setSelectedImage(null)}
        theme={theme}
      />
    </div>
  );
}
