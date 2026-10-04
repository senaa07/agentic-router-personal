import { WebSocketServer } from "ws";
import mongoose from "mongoose";
import { migrate } from "db/client";
import { UserManager } from "./UserManager";

mongoose
    .connect(process.env.DB_URL!)
    .then(() => console.log("MongoDB connected"))
    .then(migrate)
    .then((r) => console.log("Migrations:", r))
    .catch((err) => console.error("MongoDB connection/migration error:", err));
const server = new WebSocketServer({
    port: 8080,
});

server.on("connection", (ws) => {
    UserManager.getInstance().addUser(ws);

    ws.on("close", () => {
        console.log("User disconnected");
    });
});
