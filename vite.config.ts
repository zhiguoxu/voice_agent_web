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
      // 与生产 nginx 同规则的前缀分流：
      //   /api/agent/* → agent_server，原样透传（记忆/花名册等调试接口都在这个前缀下）
      //   /api/voice/* → voice_server，去掉 /voice 前缀（后端路由仍是 /api/conversations 等）
      '/api/agent': {
        target: 'http://124.220.147.121:8018',
        changeOrigin: true,
      },
      '/api/voice': {
        target: 'http://124.220.147.121:8017',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/voice/, '/api'),
      }
    }
  }
})
