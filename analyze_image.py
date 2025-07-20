#!/usr/bin/env python3
"""
图像分析脚本
调用ReThinking Park API分析图像并标记检测到的元素
"""

import requests
import json
from PIL import Image, ImageDraw, ImageFont
import os
import sys
from typing import List, Dict, Any

# API配置
API_BASE_URL = "https://api.rethinkingpark.com"
API_ENDPOINT = f"{API_BASE_URL}/api/v1/analyze"

# ReThinking Park 元素颜色配置
COLORS = {
    # 天空和大气
    'cloud': '#87CEEB',         # 天空蓝
    'sky': '#87CEFA',           # 浅天空蓝
    'light': '#FFFF99',         # 浅黄色
    'sunshine': '#FFD700',      # 金色
    'shadow': '#696969',        # 暗灰色
    'rain': '#4682B4',          # 钢蓝色
    
    # 水体元素
    'stream': '#00BFFF',        # 深天空蓝
    'river': '#0077BE',         # 海洋蓝
    'pond': '#008B8B',          # 深青色
    
    # 生物
    'human': '#FF6347',         # 番茄色
    'bird': '#1E90FF',          # 道奇蓝
    'duck': '#DAA520',          # 金黄色
    'squirrel': '#D2691E',      # 巧克力色
    'insect': '#8B4513',        # 马鞍棕色
    'dog': '#FFA500',           # 橙色
    'cat': '#FF69B4',           # 热粉色
    
    # 植被
    'tree': '#228B22',          # 森林绿
    'bush': '#9ACD32',          # 黄绿色
    'leaf': '#32CD32',          # 石灰绿
    'fallen leaf': '#CD853F',   # 秘鲁色
    'dead branch': '#8B4513',   # 马鞍棕色
    'tree shade': '#556B2F',    # 深橄榄绿
    'flower': '#FF1493',        # 深粉色
    'grass': '#90EE90',         # 浅绿色
    
    # 地形特征
    'hill': '#DEB887',          # 浅黄褐色
    'stone': '#A9A9A9',         # 深灰色
    
    'default': '#FF0000'        # 红色（默认）
}

def analyze_image(image_path: str) -> Dict[str, Any]:
    """
    调用API分析图像
    
    Args:
        image_path: 图像文件路径
        
    Returns:
        API响应的JSON数据
    """
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"图像文件不存在: {image_path}")
    
    print(f"📸 分析图像: {image_path}")
    
    try:
        with open(image_path, 'rb') as f:
            files = {'image': f}
            headers = {'Accept': 'application/json'}
            
            print("🚀 发送API请求...")
            response = requests.post(API_ENDPOINT, files=files, headers=headers, timeout=120)
            
        if response.status_code == 200:
            data = response.json()
            if data.get('success'):
                print("✅ API分析成功")
                return data
            else:
                raise Exception(f"API返回错误: {data.get('error', '未知错误')}")
        else:
            raise Exception(f"HTTP错误: {response.status_code} - {response.text}")
            
    except requests.exceptions.RequestException as e:
        raise Exception(f"网络请求失败: {str(e)}")

def draw_bounding_boxes(image_path: str, detections: List[Dict[str, Any]], output_path: str) -> None:
    """
    在图像上绘制边界框和标签
    
    Args:
        image_path: 原始图像路径
        detections: 检测结果列表
        output_path: 输出图像路径
    """
    print(f"🎨 绘制边界框到图像...")
    
    # 打开图像
    image = Image.open(image_path)
    draw = ImageDraw.Draw(image)
    
    # 获取图像尺寸
    img_width, img_height = image.size
    print(f"📐 图像尺寸: {img_width} x {img_height}")
    
    # 尝试加载字体
    try:
        # 尝试使用系统字体
        font_size = max(12, min(img_width, img_height) // 50)
        font = ImageFont.truetype("/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf", font_size)
    except (OSError, IOError):
        try:
            # 备用字体
            font = ImageFont.truetype("/System/Library/Fonts/Arial.ttf", font_size)
        except (OSError, IOError):
            # 使用默认字体
            font = ImageFont.load_default()
    
    print(f"🔍 处理 {len(detections)} 个检测结果:")
    
    # 绘制每个检测结果
    for i, detection in enumerate(detections):
        obj_type = detection['type']
        confidence = detection['confidence']
        bbox = detection['bbox']
        description = detection['description']
        
        # 转换归一化坐标为像素坐标
        x1 = int(bbox['x'] * img_width)
        y1 = int(bbox['y'] * img_height)
        x2 = int((bbox['x'] + bbox['width']) * img_width)
        y2 = int((bbox['y'] + bbox['height']) * img_height)
        
        # 获取颜色
        color = COLORS.get(obj_type, COLORS['default'])
        
        print(f"  {i+1}. {description} at ({x1},{y1})-({x2},{y2})")
        
        # 绘制边界框
        line_width = max(2, min(img_width, img_height) // 200)
        draw.rectangle([x1, y1, x2, y2], outline=color, width=line_width)
        
        # 绘制标签背景
        label_text = f"{obj_type} {confidence:.1%}"
        
        # 获取文本边界框
        try:
            bbox_text = draw.textbbox((0, 0), label_text, font=font)
            text_width = bbox_text[2] - bbox_text[0]
            text_height = bbox_text[3] - bbox_text[1]
        except AttributeError:
            # 兼容旧版本PIL
            text_width, text_height = draw.textsize(label_text, font=font)
        
        # 标签位置
        label_x = x1
        label_y = max(0, y1 - text_height - 5)
        
        # 绘制标签背景
        draw.rectangle([label_x, label_y, label_x + text_width + 4, label_y + text_height + 2], 
                      fill=color, outline=color)
        
        # 绘制标签文本
        draw.text((label_x + 2, label_y), label_text, fill='white', font=font)
    
    # 保存图像
    image.save(output_path, quality=95)
    print(f"💾 标记后的图像已保存到: {output_path}")

def main():
    """主函数"""
    # 设置路径
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # 允许用户指定图像路径，默认使用测试图像
    if len(sys.argv) > 1:
        image_path = sys.argv[1]
    else:
        # 使用已测试过的图像
        image_path = '/home/yun/文档/localai-v1/rethinkingpark-frontend/src/assets/example-park.png'
    
    # 输出路径
    output_dir = os.path.dirname(image_path)
    base_name = os.path.splitext(os.path.basename(image_path))[0]
    output_path = os.path.join(output_dir, f"{base_name}_annotated.png")
    
    try:
        print("🌳 ReThinking Park 图像分析工具")
        print("=" * 50)
        
        # 分析图像
        result = analyze_image(image_path)
        
        # 提取检测结果
        analysis = result.get('analysis', {})
        elements = analysis.get('elements', [])
        image_info = analysis.get('imageInfo', {})
        processing_time = analysis.get('processingTime', '未知')
        
        print(f"\n📊 分析结果:")
        print(f"   处理时间: {processing_time}")
        print(f"   图像尺寸: {image_info.get('width', '?')} x {image_info.get('height', '?')}")
        print(f"   图像大小: {image_info.get('size', '?')} bytes")
        print(f"   检测到 {len(elements)} 个对象")
        
        if elements:
            # 绘制边界框
            draw_bounding_boxes(image_path, elements, output_path)
            
            print(f"\n📋 检测详情:")
            for i, element in enumerate(elements, 1):
                print(f"   {i}. {element['description']}")
                bbox = element['bbox']
                print(f"      位置: ({bbox['x']:.3f}, {bbox['y']:.3f}) "
                      f"尺寸: {bbox['width']:.3f} x {bbox['height']:.3f}")
        else:
            print("❌ 未检测到任何对象")
        
        print("\n✅ 分析完成!")
        
    except KeyboardInterrupt:
        print("\n❌ 用户中断操作")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ 错误: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()