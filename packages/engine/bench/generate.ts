// 确定性大文档生成器（Spec 05 §4）：标题/表格/代码块/数学/中英混合段落循环。
// 无随机性 —— CI 与本机产出的文档逐字节一致，历史对比才有意义。
export function makeBenchmarkDoc(lines: number): string {
  const blocks: string[] = []
  let produced = 0
  for (let i = 0; produced < lines; i++) {
    const kind = i % 10
    let block: string
    if (kind === 0) {
      block = `# 标题 ${i}\n\n中文段落 ${i}，包含 **加粗**、[链接](https://example.com/${i}) 与普通文本。`
    } else if (kind === 3) {
      block = `| h${i} | v${i} |\n|---|---|\n| 行${i} | 中文单元格 |\n| 行${i + 1} | another cell |`
    } else if (kind === 6) {
      block = "```ts\nconst value" + i + " = " + i + ";\nfunction fn" + i + "() { return value" + i + " * 2; }\n```"
    } else if (kind === 8) {
      block = "$$\nE_{" + i + "} = mc^2 + " + i + "\n$$"
    } else {
      block = `段落 ${i}：中文正文与 English mixed content，用于逐键输入负载。`
    }
    blocks.push(block)
    produced += block.split("\n").length + 1
  }
  return blocks.join("\n\n")
}
