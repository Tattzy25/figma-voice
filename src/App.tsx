import { useCallback, useEffect, useRef, useState } from "react";

type Provider = "openai" | "gemini";
type WidgetState = "closed" | "connecting" | "live" | "detail";

type Collection = {
  id: string;
  title: string;
  image?: string;
  description?: string;
};

type Product = {
  id: string;
  title: string;
  image?: string;
  description?: string;
  price?: string;
};

type StorefrontConfig = {
  domain: string;
  provider: Provider;
  sessionEndpoint?: string;
  voice?: string;
};

declare global {
  interface Window {
    VoiceCommerce?: Partial<StorefrontConfig>;
  }
}

const FIRST_TURN = (domain: string) =>
  `Quickly call search_catalog. Grab all the collections from the response and render it. Do not speak at this turn yet; we are still in the connecting state until collections are rendered. You are in ${domain} storefront. You only represent ${domain}. Do this quickly so the connecting state is cleared and the interaction is live for the user.`;

const emit = (name: string, detail?: unknown) => {
  window.dispatchEvent(new CustomEvent(`voice-commerce:${name}`, { detail }));
};

function Icon({
  name,
  className = "",
}: {
  name: "close" | "mic" | "mute" | "spark" | "arrow" | "back" | "bag";
  className?: string;
}) {
  const paths = {
    close: <path d="m6 6 12 12M18 6 6 18" />,
    mic: (
      <>
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
      </>
    ),
    mute: (
      <>
        <path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9V6a3 3 0 0 0-5.6-1.5M5 11a7 7 0 0 0 11.7 5.2M12 18v3M9 21h6M3 3l18 18" />
      </>
    ),
    spark: <path d="m12 3 1.25 4.25L17.5 8.5l-4.25 1.25L12 14l-1.25-4.25L6.5 8.5l4.25-1.25L12 3ZM5.5 14l.75 2.25L8.5 17l-2.25.75L5.5 20l-.75-2.25L2.5 17l2.25-.75L5.5 14ZM19 13l.65 1.85 1.85.65-1.85.65L19 18l-.65-1.85-1.85-.65 1.85-.65L19 13Z" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    back: <path d="m15 18-6-6 6-6" />,
    bag: (
      <>
        <path d="M5 8h14l-1 13H6L5 8Z" />
        <path d="M9 10V6a3 3 0 0 1 6 0v4" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function Waveform({ quiet = false }: { quiet?: boolean }) {
  return (
    <div className={`waveform ${quiet ? "waveform--quiet" : ""}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((bar) => (
        <span key={bar} />
      ))}
    </div>
  );
}

async function discoverConfig(): Promise<StorefrontConfig> {
  const script = document.querySelector<HTMLScriptElement>("script[data-voice-commerce]");
  const manifest = document.querySelector<HTMLLinkElement>(
    'link[rel="voice-commerce"], link[rel="ucp"], link[rel="commerce-agent"]',
  );
  const domain =
    document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content ||
    document.documentElement.dataset.shopDomain ||
    window.VoiceCommerce?.domain ||
    window.location.hostname;

  let discovered: Partial<StorefrontConfig> = {};
  const wellKnownUrl = manifest?.href || `https://${domain}/.well-known/ucp`;

  try {
    const response = await fetch(wellKnownUrl, { credentials: "same-origin" });
    if (response.ok) discovered = (await response.json()) as Partial<StorefrontConfig>;
  } catch {
    // Discovery failures remain host-owned and are surfaced through the event contract.
  }

  return {
    domain: discovered.domain || domain,
    provider:
      discovered.provider === "gemini" ||
      script?.dataset.provider === "gemini" ||
      window.VoiceCommerce?.provider === "gemini"
        ? "gemini"
        : "openai",
    sessionEndpoint:
      discovered.sessionEndpoint ||
      script?.dataset.sessionEndpoint ||
      window.VoiceCommerce?.sessionEndpoint,
    voice: discovered.voice || script?.dataset.voice || window.VoiceCommerce?.voice,
  };
}

function extractCollections(value: unknown): Collection[] | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const candidate = Array.isArray(root.collections)
    ? root.collections
    : Array.isArray(root.data)
      ? root.data
      : null;
  if (!candidate) return null;

  const collections = candidate.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.title !== "string") return [];
    return [
      {
        id: item.id,
        title: item.title,
        image: typeof item.image === "string" ? item.image : undefined,
        description: typeof item.description === "string" ? item.description : undefined,
      },
    ];
  });
  return collections.length ? collections : null;
}

export default function App() {
  const [state, setState] = useState<WidgetState>("closed");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [muted, setMuted] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [statusText, setStatusText] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [domain, setDomain] = useState("");
  const connectionRef = useRef<RTCPeerConnection | WebSocket | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const consumePayload = useCallback((payload: unknown) => {
    const next = extractCollections(payload);
    if (next) {
      setCollections(next);
      setState("live");
    }
  }, []);

  useEffect(() => {
    const onCollections = (event: Event) =>
      consumePayload((event as CustomEvent).detail);
    const onProduct = (event: Event) => {
      setProduct((event as CustomEvent<Product>).detail);
      setState("detail");
    };
    const onStatus = (event: Event) =>
      setStatusText((event as CustomEvent<{ message?: string }>).detail?.message);
    const onConfirmation = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      if (detail?.message) setToast(detail.message);
    };
    const onRedirect = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (url) {
        setState("closed");
        window.location.href = url;
      }
    };

    window.addEventListener("voice-commerce:collections", onCollections);
    window.addEventListener("voice-commerce:product", onProduct);
    window.addEventListener("voice-commerce:status", onStatus);
    window.addEventListener("voice-commerce:cart-confirm", onConfirmation);
    window.addEventListener("voice-commerce:redirect", onRedirect);
    return () => {
      window.removeEventListener("voice-commerce:collections", onCollections);
      window.removeEventListener("voice-commerce:product", onProduct);
      window.removeEventListener("voice-commerce:status", onStatus);
      window.removeEventListener("voice-commerce:cart-confirm", onConfirmation);
      window.removeEventListener("voice-commerce:redirect", onRedirect);
    };
  }, [consumePayload]);

  const handleRealtimeEvent = useCallback(
    (event: MessageEvent) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = typeof message.type === "string" ? message.type : "";
      if (type.includes("audio.delta")) setAgentSpeaking(true);
      if (type.includes("audio.done") || type.includes("response.done")) {
        setAgentSpeaking(false);
      }

      const response = message.response as
        | { output?: Array<{ output?: string; content?: Array<{ text?: string }> }> }
        | undefined;
      response?.output?.forEach((item) => {
        if (typeof item.output === "string") {
          try {
            consumePayload(JSON.parse(item.output));
          } catch {
            // Non-collection tool output belongs to the host or agent.
          }
        }
      });
    },
    [consumePayload],
  );

  const connectOpenAI = useCallback(
    async (config: StorefrontConfig, stream: MediaStream) => {
      if (!config.sessionEndpoint) {
        emit("session-request", {
          provider: config.provider,
          domain: config.domain,
          firstTurn: FIRST_TURN(config.domain),
        });
        return;
      }

      const credentialResponse = await fetch(config.sessionEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: config.provider,
          domain: config.domain,
          output_modalities: ["audio"],
        }),
      });
      const credential = (await credentialResponse.json()) as {
        value?: string;
        client_secret?: { value?: string };
      };
      const token = credential.value || credential.client_secret?.value;
      if (!token) return;

      const peer = new RTCPeerConnection();
      connectionRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.ontrack = (event) => {
        if (audioRef.current) audioRef.current.srcObject = event.streams[0];
      };

      const channel = peer.createDataChannel("oai-events");
      channel.addEventListener("message", handleRealtimeEvent);
      channel.addEventListener("open", () => {
        channel.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: FIRST_TURN(config.domain) }],
            },
          }),
        );
        channel.send(JSON.stringify({ type: "response.create" }));
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const model = credentialResponse.headers.get("x-realtime-model") || "gpt-realtime";
      const realtimeResponse = await fetch(
        `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`,
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/sdp",
          },
        },
      );
      await peer.setRemoteDescription({
        type: "answer",
        sdp: await realtimeResponse.text(),
      });
    },
    [handleRealtimeEvent],
  );

  const start = async () => {
    setState("connecting");
    setStatusText(undefined);
    try {
      const config = await discoverConfig();
      setDomain(config.domain);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      emit("session-start", { ...config, firstTurn: FIRST_TURN(config.domain) });
      if (config.provider === "openai") {
        await connectOpenAI(config, stream);
      } else {
        emit("gemini-session-request", {
          config,
          stream,
          firstTurn: FIRST_TURN(config.domain),
        });
      }
    } catch (cause) {
      emit("session-error", { cause });
    }
  };

  const end = () => {
    if (connectionRef.current instanceof RTCPeerConnection) {
      connectionRef.current.getSenders().forEach((sender) => sender.track?.stop());
      connectionRef.current.close();
    } else {
      connectionRef.current?.close();
    }
    connectionRef.current = null;
    setState("closed");
    setCollections([]);
    setProduct(null);
    setToast(undefined);
    emit("session-end");
  };

  const selectCollection = (collection: Collection) => {
    emit("selection", { type: "collection", collection });
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (connectionRef.current instanceof RTCPeerConnection) {
      connectionRef.current.getSenders().forEach((sender) => {
        if (sender.track?.kind === "audio") sender.track.enabled = !next;
      });
    }
  };

  return (
    <main className="storefront-canvas">
      <audio ref={audioRef} autoPlay />

      {state !== "closed" && (
        <section className="voice-widget" aria-label="Voice shopping assistant">
          <header className="widget-header">
            <div className="brand-mark">
              <Icon name="spark" />
            </div>
            <div className="header-copy">
              <p className="eyebrow">{domain || "Store assistant"}</p>
              <div className="live-status">
                <span className={state === "connecting" ? "status-dot waiting" : "status-dot"} />
                <p>{state === "connecting" ? "Connecting" : statusText || "Live"}</p>
              </div>
            </div>
            <button className="icon-button" onClick={end} aria-label="End voice session">
              <Icon name="close" />
            </button>
          </header>

          {state === "connecting" ? (
            <div className="connecting-view">
              <div className="orb orb--connecting">
                <Waveform quiet />
              </div>
              <div>
                <p className="overline">Preparing your store guide</p>
                <p className="connecting-title">Finding what you’ll love</p>
              </div>
              <div className="collection-skeletons" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : state === "detail" && product ? (
            <div className="detail-view">
              <button className="back-button" onClick={() => setState("live")}>
                <Icon name="back" />
                <span>Back</span>
              </button>
              {product.image && <img className="product-image" src={product.image} alt="" />}
              <div className="detail-copy">
                <p className="detail-title">{product.title}</p>
                {product.price && <p className="product-price">{product.price}</p>}
                {product.description && (
                  <p className="product-description">{product.description}</p>
                )}
                <button
                  className="primary-action"
                  onClick={() => emit("action", { type: "add_to_cart", product })}
                >
                  <Icon name="bag" />
                  <span>Add to cart</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="discovery-view">
              <div className="voice-stage">
                <div className={`orb ${agentSpeaking ? "orb--speaking" : ""}`}>
                  <Waveform quiet={!agentSpeaking} />
                </div>
                <div>
                  <p className="overline">{agentSpeaking ? "Assistant speaking" : "Listening"}</p>
                  <p className="voice-prompt">Ask me anything about the store</p>
                </div>
              </div>

              <div className="collections">
                <div className="section-heading">
                  <p>Explore collections</p>
                  <span>{collections.length}</span>
                </div>
                <div className="collection-list">
                  {collections.map((collection) => (
                    <button
                      className="collection-card"
                      key={collection.id}
                      onClick={() => selectCollection(collection)}
                    >
                      <span className="collection-image-wrap">
                        {collection.image && (
                          <img src={collection.image} alt="" className="collection-image" />
                        )}
                      </span>
                      <span className="collection-copy">
                        <strong>{collection.title}</strong>
                        {collection.description && <small>{collection.description}</small>}
                      </span>
                      <Icon name="arrow" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {toast && (
            <div className="toast" role="status">
              <span className="toast-icon">
                <Icon name="bag" />
              </span>
              <p>{toast}</p>
              <button onClick={() => setToast(undefined)} aria-label="Dismiss">
                <Icon name="close" />
              </button>
            </div>
          )}

          {state !== "connecting" && (
            <footer className="call-controls">
              <button
                className={`mute-button ${muted ? "is-muted" : ""}`}
                onClick={toggleMute}
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              >
                <Icon name={muted ? "mute" : "mic"} />
              </button>
              <div>
                <p>{muted ? "Microphone off" : "Voice session active"}</p>
                <small>Tap the mic to {muted ? "unmute" : "mute"}</small>
              </div>
              <button className="end-button" onClick={end}>
                End
              </button>
            </footer>
          )}
        </section>
      )}

      {state === "closed" && (
        <button className="voice-launcher" onClick={start} aria-label="Start voice shopping">
          <span className="launcher-ring" />
          <Icon name="mic" />
          <span className="launcher-label">Shop with voice</span>
        </button>
      )}
    </main>
  );
}
