import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 注入前端版本号（取自 package.json，由 npm run build/dev 设置的 npm_package_version）
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://124.220.147.121:8017',
        changeOrigin: true,
      }
    }
  }
})
