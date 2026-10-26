module.exports = {
  apps: [
    {
      name: 'apiaberta-base',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3003,
        MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/apiaberta-base'
        // BASE_API_KEY is read from process.env / .env only — never hardcode secrets here
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000
    }
  ]
}
