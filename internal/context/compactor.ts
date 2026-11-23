import { RoleAssistant, RoleSystem, RoleUser, type Message } from "../schema/message.js";

export class Compactor {
  constructor(
    readonly maxChars: number,
    readonly retainLastMsgs: number,
  ) {
    if (!Number.isInteger(maxChars) || maxChars <= 0 || !Number.isInteger(retainLastMsgs) || retainLastMsgs < 0) {
      throw new RangeError("maxChars must be positive and retainLastMsgs must be non-negative integers");
    }
  }

  compact(messages: readonly Message[]): Message[] {
    // Match the Go example's UTF-8 byte estimate, including serialized tool arguments.
    const length = messages.reduce((total, message) => total + Buffer.byteLength(message.content) +
      (message.toolCalls ?? []).reduce((sum, call) => sum + Buffer.byteLength(call.name) +
        Buffer.byteLength(JSON.stringify(call.arguments)), 0), 0);
    if (length < this.maxChars) return [...messages];

    const protectStart = Math.max(0, messages.length - this.retainLastMsgs);
    return messages.map((message, index) => {
      if (message.role === RoleSystem) return message;
      const size = Buffer.byteLength(message.content);
      if (message.role === RoleUser && message.toolCallId) {
        if (index < protectStart && size > 200) {
          return { ...message, content: `...[为了节省内存，早期的工具输出已被系统强制清理。原始长度: ${size} 字节]...` };
        }
        if (index >= protectStart && size > 1000) {
          const chars = Array.from(message.content);
          let headEnd = 0;
          let headBytes = 0;
          while (headEnd < chars.length && headBytes + Buffer.byteLength(chars[headEnd]!) <= 500) {
            headBytes += Buffer.byteLength(chars[headEnd++]!);
          }
          let tailStart = chars.length;
          let tailBytes = 0;
          while (tailStart > headEnd && tailBytes + Buffer.byteLength(chars[tailStart - 1]!) <= 500) {
            tailBytes += Buffer.byteLength(chars[--tailStart]!);
          }
          return {
            ...message,
            content: `${chars.slice(0, headEnd).join("")}\n\n...[内容过长，中间 ${size - headBytes - tailBytes} 字节已被系统截断]...\n\n${chars.slice(tailStart).join("")}`,
          };
        }
      } else if (message.role === RoleAssistant && index < protectStart && size > 200) {
        return { ...message, content: "...[早期的推理思考过程已折叠]..." };
      }
      return message;
    });
  }
}
