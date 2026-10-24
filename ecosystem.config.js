module.exports = {
  apps: [
    {
      name: 'lol-embed-player',
      script: 'scripts/player-server.mjs',
      // HLS sessions and ffmpeg children belong to one process. Clustering
      // without sticky/shared sessions breaks playlist and segment requests.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        PLAYER_PORT: 3000,
        HOST: '0.0.0.0',
        MKV_HLS_ENABLED: 'true',
        MKV_HLS_NODE_HOST: 'true'
      }
    }
  ]
};
