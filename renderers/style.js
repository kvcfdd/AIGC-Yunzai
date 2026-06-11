/**
 * 全局美颜滤镜配置
 * 用于解决 Linux 服务器渲染图片字体细、颜色淡的问题
 */
export const globalStyle = `
  html {
    /* 
      稍微加一点对比度和饱和度，去灰 
      saturate(1.15): 饱和度 +15%
      contrast(1.08): 对比度 +8%
    */
    filter: contrast(1.05) saturate(1.1);
    
    /* 保证缩放时的图片质量 */
    image-rendering: -webkit-optimize-contrast;
  }

  body {
    /* 
      给字体加 0.15px 的描边，模拟 Windows 的厚重感 
      currentColor 会自动跟随文字颜色，不会破坏插件原有配色
    */
    -webkit-text-stroke: 0.15px currentColor;
    
    /* 开启抗锯齿 */
    -webkit-font-smoothing: antialiased;
  }

  /* 防止图片也被描边 */
  img, svg, canvas {
    -webkit-text-stroke: 0px;
  }
`
