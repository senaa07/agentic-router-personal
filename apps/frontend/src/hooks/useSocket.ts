import { useEffect, useState } from "react";

export type SocketStatus = "connecting" | "open" | "closed";

const URL = "ws://localhost:8080";
const RETRY_MS = 2000;

// Connects to the backend and reconnects whenever the connection drops.
// The socket is exposed before it opens so handlers are attached in time for
// the server's first message; check `status` (or readyState) before sending.
export function useSocket() {
    const [ws, setWs] = useState<WebSocket | null>(null);
    const [status, setStatus] = useState<SocketStatus>("connecting");
    useEffect(() => {
        let current: WebSocket;
        let retry: ReturnType<typeof setTimeout>;
        let stopped = false;

        const connect = () => {
            current = new WebSocket(URL);
            setWs(current);
            // Status stays "closed" across retries (no flicker) until a connection opens
            current.onopen = () => setStatus("open");
            current.onclose = () => {
                if (stopped) return;
                setStatus("closed");
                retry = setTimeout(connect, RETRY_MS);
            };
        };
        connect();

        return () => {
            stopped = true;
            clearTimeout(retry);
            // Closing a still-connecting socket logs a browser warning, so wait for it to open
            if (current.readyState === WebSocket.CONNECTING) {
                current.onopen = () => current.close();
            } else {
                current.close();
            }
        };
    }, []);
    return {
        socket: ws,
        status,
    };
}
