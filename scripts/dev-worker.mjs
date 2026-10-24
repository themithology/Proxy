// Backward-compatible development entrypoint. The production implementation
// lives here so Docker, PM2 and Codespaces all run the identical player.
import './player-server.mjs';
