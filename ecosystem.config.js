module.exports = {
  apps: [
    {
      // REST API — stateless, so this is the one that benefits from PM2
      // cluster mode. Fixed at 2 instances rather than 'max': this box also
      // runs the voice-gateway process below, which needs its own CPU
      // headroom — claiming every core here would starve it. Raise this if
      // the box has more cores to spare and voice traffic stays light.
      name: 'ai-server-api',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // Safety net against a slow memory leak silently degrading a worker
      // over time (GC pauses stalling the event loop look exactly like
      // "the server is taking too long to respond" from the client's side,
      // with nothing that throws for the exception filter to catch).
      // autorestart alone only helps on an actual crash, not a process
      // that's alive but bloated — this forces a clean restart before that
      // happens. Tune the number to this box's actual available RAM.
      max_memory_restart: '1G',
      watch: false,
      out_file: 'logs/api-out.log',
      error_file: 'logs/api-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true,
    },
    {
      // Voice gateway (Socket.IO) — split out from the REST API so a burst
      // of concurrent voice sessions (audio streaming, Deepgram events,
      // Claude streaming) can't starve simple REST reads. Single instance,
      // fork mode: each socket connection's session state lives in this
      // process's memory (VoiceGateway's `sessions` Map) — clustering it
      // would need sticky-session routing plus a shared adapter (Redis) so
      // reconnects/broadcasts work across instances, neither of which is
      // set up yet. Revisit once that's in place.
      name: 'ai-voice-gateway',
      script: 'dist/main-gateway.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        // Must differ from the API's PORT and match what nginx proxies
        // /socket.io/* to (see the nginx snippet in the deployment notes).
        VOICE_GATEWAY_PORT: process.env.VOICE_GATEWAY_PORT || '3002',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '1G',
      watch: false,
      out_file: 'logs/gateway-out.log',
      error_file: 'logs/gateway-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true,
    },
  ],
};
