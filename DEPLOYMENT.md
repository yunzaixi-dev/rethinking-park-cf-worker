# 🚀 部署指南

## 步骤1: Cloudflare账户设置

### 1.1 创建Cloudflare账户
如果还没有Cloudflare账户：
1. 访问 [Cloudflare](https://cloudflare.com)
2. 注册新账户
3. 验证邮箱

### 1.2 登录Wrangler
```bash
wrangler login
```
这会打开浏览器进行OAuth认证。

### 1.3 验证登录状态
```bash
wrangler whoami
```

## 步骤2: 部署Worker

### 2.1 首次部署
```bash
npm run deploy
```

### 2.2 查看部署信息
部署成功后，您会看到类似的输出：
```
✨ Success! Uploaded 1 files
🌎 Deploying...
✨ Success!
Your worker has been published.
🌐 https://rethinking-park-cf-worker.your-subdomain.workers.dev
```

## 步骤3: 测试部署的API

### 3.1 健康检查
```bash
curl https://rethinking-park-cf-worker.your-subdomain.workers.dev/api/v1/health
```

### 3.2 图像分析测试
```bash
curl -X POST \
  -F "image=@/path/to/your/image.jpg" \
  https://rethinking-park-cf-worker.your-subdomain.workers.dev/api/v1/analyze
```

## 步骤4: 配置自定义域名（可选）

### 4.1 添加自定义域名
```bash
wrangler domains add api.your-domain.com
```

### 4.2 配置DNS
在您的域名提供商处添加CNAME记录：
```
api.your-domain.com CNAME your-subdomain.workers.dev
```

## 步骤5: 环境变量配置

### 5.1 生产环境变量
```bash
wrangler secret put API_KEY
wrangler secret put DATABASE_URL
```

### 5.2 非敏感变量
在 `wrangler.jsonc` 中配置：
```json
{
  "vars": {
    "ENVIRONMENT": "production",
    "CACHE_TTL": "7200",
    "MAX_FILE_SIZE": "20971520"
  }
}
```

## 🔧 故障排除

### 认证问题
```bash
# 重新登录
wrangler logout
wrangler login
```

### 部署权限问题
确保您的Cloudflare账户有Workers权限：
1. 访问Cloudflare Dashboard
2. 检查Workers & Pages服务是否可用

### AI模型访问问题
确保您的Cloudflare账户已启用Workers AI：
1. 访问 Cloudflare Dashboard > Workers & Pages
2. 启用 Workers AI 服务

## 📊 监控和日志

### 查看实时日志
```bash
wrangler tail
```

### 查看部署状态
```bash
wrangler status
```

### Cloudflare Dashboard
访问 [Cloudflare Dashboard](https://dash.cloudflare.com) 查看：
- 请求统计
- 错误率
- 响应时间
- AI使用情况

## 💰 费用优化

### 免费额度监控
- Workers: 100,000 请求/天
- Workers AI: 10,000 神经元/天

### 设置使用限制
```bash
# 设置日请求限制
wrangler configure limits daily-requests 50000
```

### 监控使用情况
在Cloudflare Dashboard中设置预算警报。

## 🔄 CI/CD集成

### GitHub Actions示例
创建 `.github/workflows/deploy.yml`:
```yaml
name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Deploy to Cloudflare Workers
        run: npm run deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## 🌍 多环境部署

### 开发环境
```bash
wrangler deploy --env development
```

### 生产环境
```bash
wrangler deploy --env production
```

在 `wrangler.jsonc` 中配置环境：
```json
{
  "name": "rethinking-park-cf-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-07-19",
  "env": {
    "development": {
      "vars": {
        "ENVIRONMENT": "development"
      }
    },
    "production": {
      "vars": {
        "ENVIRONMENT": "production"
      }
    }
  }
}
```

## 📚 下一步

1. **自定义域名**: 配置您的API域名
2. **监控设置**: 设置警报和监控
3. **前端集成**: 更新前端API端点
4. **性能优化**: 根据使用情况调整配置
5. **扩展功能**: 添加更多AI模型和功能