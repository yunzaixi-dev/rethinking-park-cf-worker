# ReThinking Park - Cloudflare Worker AI Backend

基于Cloudflare Workers AI的ReThinking Parks项目后端API服务。

## 🚀 项目概述

这是ReThinking Parks项目的新后端实现，使用Cloudflare Workers AI替代Google Cloud Vision API。提供图像分析和自然元素识别功能。

## ✨ 特性

- **🤖 AI图像分析**: 使用Cloudflare AI (@cf/microsoft/resnet-50) 进行图像分类
- **🌿 自然元素识别**: 智能识别图像中的自然元素（树木、水体、天空等）
- **⚡ 边缘计算**: 全球分布式部署，低延迟响应
- **💾 智能缓存**: 内存缓存减少重复分析
- **🔒 安全验证**: 文件类型和大小验证
- **🌐 CORS支持**: 支持跨域前端调用
- **📊 健康监控**: 健康检查和状态监控

## 🛠️ 技术栈

- **Cloudflare Workers**: 无服务器计算平台
- **Cloudflare AI**: 机器学习推理服务
- **TypeScript**: 类型安全的开发体验
- **Wrangler**: Cloudflare Workers开发工具

## 📋 API 端点

### 健康检查
```
GET /api/v1/health
```

响应:
```json
{
  "status": "healthy",
  "timestamp": "2025-07-19T08:00:00.000Z",
  "cache_size": 0,
  "service": "ReThinking Park Cloudflare Worker"
}
```

### 图像分析
```
POST /api/v1/analyze
Content-Type: multipart/form-data
```

参数:
- `image`: 图像文件 (JPEG, PNG, WebP, 最大10MB)

响应:
```json
{
  "success": true,
  "analysis": {
    "elements": [
      {
        "type": "tree",
        "confidence": 0.95,
        "description": "Tree"
      },
      {
        "type": "grass",
        "confidence": 0.87,
        "description": "Grass"
      }
    ],
    "processingTime": "1234ms",
    "timestamp": "2025-07-19T08:00:00.000Z",
    "imageHash": "abc123...",
    "cacheHit": false
  },
  "timestamp": "2025-07-19T08:00:00.000Z"
}
```

## 🚀 快速开始

### 1. 克隆并安装依赖
```bash
cd rethinking-park-cf-worker
npm install
```

### 2. 本地开发
```bash
npm run dev
```
服务器将在 http://localhost:8787 启动

### 3. 部署到Cloudflare
```bash
# 首次部署前需要登录
wrangler login

# 部署
npm run deploy
```

## 🧪 测试API

### 健康检查
```bash
curl http://localhost:8787/api/v1/health
```

### 图像分析
```bash
curl -X POST \
  -F "image=@/path/to/your/image.jpg" \
  http://localhost:8787/api/v1/analyze
```

## 🌿 支持的自然元素

系统能识别以下自然元素类型：

**基础元素**:
- tree, water, mountain, sky, grass, flower, rock, cloud

**植被**:
- leaf, branch, plant, forest, vegetation, bushes, moss, fern, flowers, greenery, foliage

**地貌**:
- lake, river, ocean, beach, sand, stone, landscape, field, meadow, hill, valley

**环境**:
- nature, outdoor, garden, park, sunset, sunrise, shadow, sunlight

**生物**:
- bird, animal, wildlife

## 💰 费用说明

### Cloudflare Workers免费额度
- **请求数**: 100,000 请求/天
- **CPU时间**: 10ms/请求
- **内存**: 128MB

### Cloudflare AI免费额度
- **神经元**: 10,000 神经元/天
- **推理调用**: 充足的免费额度用于开发测试

### 预期费用
- **开发测试**: 通常完全免费
- **轻度生产使用**: $0-5/月
- **中等使用**: $5-25/月

## ⚙️ 配置选项

在 `wrangler.jsonc` 中配置:

```json
{
  "vars": {
    "CACHE_TTL": "3600",        // 缓存时间（秒）
    "MAX_FILE_SIZE": "10485760" // 最大文件大小（字节）
  }
}
```

## 🔧 开发指南

### 项目结构
```
src/
├── index.ts           # 主要Worker代码
└── types/            # 类型定义
test/
├── index.spec.ts     # 单元测试
└── env.d.ts          # 测试环境类型
```

### 本地测试
```bash
npm test
```

### 类型检查
```bash
npm run cf-typegen
```

## 🚀 部署流程

1. **开发环境测试**
   ```bash
   npm run dev
   ```

2. **运行测试**
   ```bash
   npm test
   ```

3. **部署到Cloudflare**
   ```bash
   npm run deploy
   ```

## 🌐 与前端集成

更新前端配置以使用新的API端点:

```typescript
// 替换原来的Google Cloud后端URL
const API_BASE_URL = 'https://your-worker.your-subdomain.workers.dev'

// API调用示例
const analyzeImage = async (imageFile: File) => {
  const formData = new FormData()
  formData.append('image', imageFile)
  
  const response = await fetch(`${API_BASE_URL}/api/v1/analyze`, {
    method: 'POST',
    body: formData
  })
  
  return response.json()
}
```

## 🛡️ 安全特性

- **文件类型验证**: 只允许JPEG, PNG, WebP格式
- **文件大小限制**: 默认最大10MB
- **输入清理**: 防止恶意输入
- **错误处理**: 完善的错误处理和日志记录

## 📊 监控和日志

- **Cloudflare Analytics**: 自动提供请求统计
- **实时日志**: 通过 `wrangler tail` 查看
- **错误跟踪**: 详细的错误日志和堆栈跟踪

## 🔄 从Google Cloud迁移

这个新后端完全兼容原有的API接口，只需要：

1. 更新前端API端点URL
2. 无需更改任何API调用代码
3. 响应格式保持一致

## 📚 相关链接

- [Cloudflare Workers文档](https://developers.cloudflare.com/workers/)
- [Cloudflare AI文档](https://developers.cloudflare.com/workers-ai/)
- [Wrangler CLI文档](https://developers.cloudflare.com/workers/wrangler/)

## 🤝 贡献

欢迎提交Issue和Pull Request来改进项目！

## 📄 许可证

MIT License