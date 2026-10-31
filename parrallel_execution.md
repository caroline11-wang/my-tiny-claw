# 为什么 Promise.all(toolCalls.map(...)) 能并发调用工具？

对应代码：[internal/engine/loop.ts](./internal/engine/loop.ts) 中的工具执行阶段。

关键是：**`map()` 会连续启动每个异步任务，而不会等待前一个任务完成；`Promise.all()` 再统一等待它们的结果。**

## 1. 串行写法为什么会依次执行？

```ts
for (const toolCall of toolCalls) {
  const result = await registry.execute(signal, toolCall);
}
```

这里的 `await` 在循环内部，会暂停整个异步函数中的循环，直到当前工具完成：

```text
启动工具 A → 等 A 完成 → 启动工具 B → 等 B 完成
```

假设两个工具各耗时 2 秒，总耗时约为 **4 秒**。

## 2. map() 为什么不会等待前一个工具？

并发写法简化后如下：

```ts
const observations = await Promise.all(
  toolCalls.map(async (toolCall) => {
    const result = await registry.execute(signal, toolCall);
    return result;
  }),
);
```

首先，`map()` 按顺序调用数组中每个元素对应的异步函数：

```text
调用 A 的异步函数 → A 开始执行，返回一个 Promise
调用 B 的异步函数 → B 开始执行，返回一个 Promise
```

其中：

```ts
async (toolCall) => {
  const result = await registry.execute(signal, toolCall);
  return result;
}
```

**这里的 `await` 只暂停当前这个异步回调，不会暂停外面的 `map()`。**

当 A 等待文件读取或命令执行结果时，其异步回调会让出执行权，`map()` 可以继续调用 B 的异步回调。因此，A 和 B 的执行时间可以重叠。

`map()` 最终得到一个 Promise 数组：

```ts
[promiseA, promiseB]
```

## 3. Promise.all() 做了什么？

接下来执行：

```ts
const observations = await Promise.all([promiseA, promiseB]);
```

当所有输入 Promise 都成功完成时，`Promise.all()` 返回的 Promise 才会成功完成，主流程才继续。

```text
时间       0 秒                  2 秒
工具 A     启动 ─────────────── 完成
工具 B     启动 ─────────────── 完成
主流程     等待所有工具 ──────── 继续下一轮
```

假设两个工具各耗时 2 秒，并且互不依赖、没有额外资源争用，总耗时约为 **2 秒**，而不是 4 秒。

结果数组的顺序与输入顺序一致，不受完成先后影响：

```text
输入顺序：A、B
完成顺序：B、A
结果顺序：A 的结果、B 的结果
```

因此，引擎可以等待工具结果聚合后，按模型原始调用顺序回填上下文。

如果某个 Promise 拒绝，`Promise.all()` 会提前拒绝，但不会自动取消其余任务。本项目的真实 Registry 会将工具执行异常转换为 `isError=true` 的结果，因此通常的工具业务错误仍能参与结果聚合。

## 4. “同时”更准确地说是“并发”

这些工具并不是在完全相同的瞬间启动，而是**先后快速启动，执行期间可以重叠**。

`Promise.all()` 本身不会创建线程，也不是它启动了工具。真正启动工具执行的是：

```ts
registry.execute(signal, toolCall)
```

异步回调在第一个 `await` 之前的同步代码仍然依次执行。如果工具内部是长时间阻塞 JavaScript 线程的同步计算，使用 `Promise.all()` 不会自动将它变成多线程并行计算。

文件读取、子进程命令执行等异步操作可以在等待期间重叠进行，正是当前工具并发执行的主要收益。

## 总结

**`map()` 不等前一个工具结束就启动下一个，`Promise.all()` 负责等待并按原顺序收集结果。**

同一轮中的工具应互相独立；有先后依赖或会冲突修改同一文件的操作，应拆到不同轮执行。

---

# 系统理解 Promise、async、await、resolve 与 reject

下面从“为什么需要异步”开始，把 Promise、async、await、resolve、reject 串起来。
示例使用 TypeScript，但运行机制与 JavaScript 相同。

## 一、先看整体关系

这些名称并不全是关键字：

| 名称 | 是什么 | 用途 |
|---|---|---|
| `Promise` | 内置对象的构造器 | 表示异步操作的完成状态与结果 |
| `async` | 定义异步函数的关键字 | 使函数始终返回 Promise |
| `await` | 等待值的运算符，通常用于异步函数内 | 暂停当前函数，等待 Promise 的结果 |
| `resolve` | 创建 Promise 时获得的函数，名称可自行修改 | 交付结果，或让当前 Promise 跟随另一个 Promise |
| `reject` | 创建 Promise 时获得的函数，名称可自行修改 | 将 Promise 标记为失败 |
| `.then()` | Promise 方法 | 注册成功后的处理逻辑 |
| `.catch()` | Promise 方法 | 注册失败后的处理逻辑 |
| `.finally()` | Promise 方法 | 注册成功或失败后都要执行的清理逻辑 |

先记住这条主线：

```text
启动操作 → 拿到 Promise → 等操作完成 → 取得结果或处理错误
```

## 二、为什么需要 Promise？

### 1. 普通函数可以直接返回结果

```ts
function getNumber(): number {
  return 42;
}

const result = getNumber(); // 42
```

但读取文件、访问网络等操作，结果通常不能立即得到。

我们不希望程序为了等待网络响应，阻塞整个 JavaScript 线程。因此先返回一个对象，
代表这个尚未完成的操作——这就是 Promise 的用途。

```ts
const promise = fetch("https://example.com");
```

这里得到的是 `Promise<Response>`，不是已经取得的网页响应。

> Promise 本身不会创建线程，也不会自动把耗时的同步代码变成非阻塞操作。

## 三、Promise：代表操作状态和结果

Promise 有三种状态：

```text
pending：等待中
  ├── fulfilled：成功，带有结果值
  └── rejected：失败，带有失败原因
```

成功或失败后，状态就确定了，不会再从成功变回等待或变成失败。

### 1. 如何创建 Promise？

沿用之前的工具例子：

```ts
function executeTool(name: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    console.log(`启动工具 ${name}`);

    setTimeout(() => {
      if (name === "") {
        reject(new Error("工具名不能为空"));
        return;
      }

      resolve(`工具 ${name} 执行完成`);
    }, 2000);
  });
}
```

调用：

```ts
const promiseA = executeTool("A");
```

此时：

- “启动工具 A”立即打印；
- 计时器被安排；
- 函数立即返回 Promise；
- 约两秒后，Promise 成功完成。

**`new Promise(...)` 内部的回调立即执行，并不是等到 `await` 才执行。**

### 2. 类型声明不会创建 Promise

```ts
function executeTool(): Promise<string> {
  // 这里只展示签名；实际实现必须返回 Promise。
}
```

`: Promise<string>` 只是告诉 TypeScript：

> 这个函数应该返回一个 Promise，它成功后的结果是字符串。

真正产生返回值的是：

```ts
return new Promise<string>(...);
```

或者下面要讲的 `async` 函数。

## 四、resolve 和 reject：怎样交付结果？

### 1. resolve：交付成功结果

```ts
const promise = new Promise<string>((resolve) => {
  resolve("你好");
});
```

这个 Promise 成功完成，结果是 `"你好"`。

```ts
const result = await promise;
console.log(result); // 你好
```

### 2. reject：交付失败原因

```ts
const promise = new Promise<string>((resolve, reject) => {
  reject(new Error("读取失败"));
});
```

等待这个 Promise 时，就会得到错误，而不是成功结果：

```ts
try {
  const result = await promise;
  console.log(result);
} catch (error) {
  console.error("操作失败：", error);
}
```

通常用 `Error` 对象作为失败原因，便于保留错误信息和调用栈。

### 3. 它们不是 return

```ts
new Promise<string>((resolve) => {
  resolve("完成");

  console.log("这里仍然会执行");
});
```

`resolve()` 不会结束当前函数。需要停止往下执行时，显式写 `return`：

```ts
reject(new Error("输入无效"));
return;
```

### 4. 一个更准确的细节

当传给 `resolve` 的是普通值：

```ts
resolve("完成");
```

Promise 可以成功完成。

当传给它的是另一个 Promise：

```ts
resolve(otherPromise);
```

当前 Promise 会跟随另一个 Promise 的最终状态。所以 `resolve` 并不总意味着“立刻成功”。
初学时，先理解普通值的情况即可。

## 五、then()：结果到了以后做什么？

```ts
executeTool("A").then((result) => {
  console.log(result);
});

console.log("外面的代码继续执行");
```

输出：

```text
启动工具 A
外面的代码继续执行
……约两秒后……
工具 A 执行完成
```

`.then()` 注册了一个回调：

> Promise 成功后，把结果传给这个回调。

**`.then()` 自己也会返回一个新的 Promise**，所以可以串联：

```ts
Promise.resolve(10)
  .then((number) => number * 2)
  .then((number) => {
    console.log(number); // 20
  });
```

前一个 `.then()` 返回的值，会成为下一个 `.then()` 接收的结果。

如果返回的是 Promise，链条会等待它：

```ts
executeTool("A")
  .then(() => executeTool("B"))
  .then((resultB) => {
    console.log(resultB);
  });
```

这里是 A 完成后再启动 B，因此串行。

## 六、async：让函数始终返回 Promise

```ts
async function getNumber(): Promise<number> {
  return 42;
}
```

虽然函数内部返回的是 `42`，但调用者拿到的是 Promise：

```ts
const promise = getNumber(); // Promise<number>
const number = await promise; // 42
```

可以理解为：

```text
函数内部 return 42
        ↓
async 向调用者提供一个成功结果为 42 的 Promise
```

如果 `async` 函数抛出错误，它返回的 Promise 会失败：

```ts
async function getNumber(): Promise<number> {
  throw new Error("获取失败");
}
```

### async 不代表自动暂停

```ts
async function example() {
  console.log("A");
  console.log("B");
}

example();
console.log("C");
```

输出：

```text
A
B
C
```

没有执行到 `await`，函数里的同步代码仍然连续执行。

## 七、await：暂停当前函数，取得结果

```ts
async function main() {
  const promiseA = executeTool("A");

  const resultA = await promiseA;

  console.log(resultA);
}
```

区分两个变量：

| 变量 | 类型 | 内容 |
|---|---|---|
| `promiseA` | `Promise<string>` | 代表工具 A 操作的 Promise |
| `resultA` | `string` | `"工具 A 执行完成"` |

**`await` 不会把 `promiseA` 变成字符串，而是取得其成功结果并赋给 `resultA`。**

### 1. 暂停当前函数，不阻塞线程

```ts
async function main() {
  console.log("① 开始");

  const result = await executeTool("A");

  console.log("③ 拿到结果", result);
}

main();

console.log("② 外面的代码继续执行");
```

输出：

```text
① 开始
启动工具 A
② 外面的代码继续执行
……约两秒后……
③ 拿到结果 工具 A 执行完成
```

`main()` 暂停期间，线程可以执行其他就绪的代码。

### 2. Promise 失败时，await 会抛出错误

```ts
async function main() {
  try {
    const result = await executeTool("");
    console.log(result);
  } catch (error) {
    console.error("工具执行失败：", error);
  }
}
```

### 3. await 一般写在哪里？

通常写在 `async` 函数内部。现代 JavaScript 的 ES 模块也允许顶层 `await`。

另外，即使 Promise 已成功完成，`await` 后面的代码也会在后续的微任务中恢复，
而不是直接在当前调用栈里继续。初学时可以记为：**`await` 是一个让出执行权的位置。**

## 八、串行还是并发，关键看“何时启动”

这是与项目最相关的部分。

### 1. 串行：启动一个，等待一个

```ts
async function main() {
  const a = await executeTool("A");
  const b = await executeTool("B");
}
```

```text
启动 A → 等 A 完成 → 启动 B → 等 B 完成
```

两个操作各需要两秒，总时间约四秒。

适合有依赖的操作：

```ts
const user = await fetchUser();
const orders = await fetchOrders(user.id);
```

查询订单需要先拿到用户 ID，因此应该等待。

### 2. 并发：先都启动，再统一等待

```ts
async function main() {
  const promiseA = executeTool("A");
  const promiseB = executeTool("B");

  const [a, b] = await Promise.all([promiseA, promiseB]);

  console.log(a, b);
}
```

```text
启动 A ─────────→ 完成
启动 B ─────────→ 完成
等待全部完成 ───→ 继续
```

两个独立操作各需要两秒，总时间约两秒。

适合互相独立的操作，例如同时读取三个不同文件。

### 3. 为什么项目中的 map 可以并发？

```ts
const results = await Promise.all(
  toolCalls.map((call) => registry.execute(signal, call)),
);
```

执行顺序：

```text
map 调用工具 A → 拿到 PromiseA
map 调用工具 B → 拿到 PromiseB
map 调用工具 C → 拿到 PromiseC

Promise.all 等待三个 Promise
```

不是 `Promise.all()` 启动了工具，而是 `map()` 中对 `execute()` 的调用启动了工具操作。

## 九、Promise.all 等常用方法

| 方法 | 什么时候完成 | 典型场景 |
|---|---|---|
| `Promise.all()` | 全部成功才成功；任意一个失败就拒绝 | 所有结果都需要 |
| `Promise.allSettled()` | 等全部结束，逐项返回成功或失败状态 | 想收集每项结果，不因单项失败提前结束 |
| `Promise.race()` | 跟随第一个成功或失败的输入 | 竞争响应、构建超时逻辑 |
| `Promise.any()` | 第一个成功就成功；全部失败才拒绝 | 多个备用来源，任一成功即可 |

`Promise.all()` 的结果按输入顺序排列，不是按完成顺序。

另外，这些聚合方法都不会自动取消其他操作。例如 `Promise.race()` 中超时 Promise
先完成，并不代表网络请求已经被终止；真正取消通常需要底层 API 支持 `AbortSignal`。

## 十、错误处理与清理

使用 `async` / `await` 时：

```ts
async function main() {
  try {
    const result = await executeTool("A");
    console.log(result);
  } catch (error) {
    console.error("执行失败：", error);
  } finally {
    console.log("成功或失败后，都执行清理");
  }
}
```

使用 Promise 链时：

```ts
executeTool("A")
  .then((result) => {
    console.log(result);
  })
  .catch((error) => {
    console.error("执行失败：", error);
  })
  .finally(() => {
    console.log("成功或失败后，都执行清理");
  });
```

`.catch()` 如果正常返回，相当于处理了错误，后续 Promise 链会恢复为成功状态。
不能恢复时，可以继续抛出：

```ts
.catch((error) => {
  console.error("执行失败：", error);
  throw error;
});
```

## 十一、什么时候需要自己写 new Promise？

当你要把回调或事件形式的 API，转换为 Promise 时。

例如计时器：

```ts
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
```

调用：

```ts
await delay(2000);
console.log("两秒到了");
```

如果 API 已经返回 Promise，就不用再包装：

```ts
import { readFile } from "node:fs/promises";

async function loadFile(): Promise<string> {
  return await readFile("a.txt", "utf8");
}
```

这里 `readFile()` 已返回 Promise，所以不需要额外写 `new Promise(...)`。

## 十二、几个容易混淆的地方

### 误区 1：async 会创建线程

不会。它主要改变函数返回方式，并允许使用 `await`。

### 误区 2：await 才会启动操作

不是。通常是函数调用启动操作：

```ts
const promise = executeTool("A"); // 已启动
const result = await promise;    // 等结果
```

### 误区 3：函数返回类型写 Promise，就自动返回 Promise

不会。类型声明只是检查要求，实际还需要返回 Promise，或者将函数定义为 `async`。

### 误区 4：两个 await 一定是串行操作

不一定。看操作是否已经提前启动：

```ts
const promiseA = executeTool("A");
const promiseB = executeTool("B");

// A、B 已启动，可以重叠执行。
const a = await promiseA;
const b = await promiseB;
```

不过，对于独立任务，通常更推荐 `Promise.all()`，及时为两个 Promise 都建立失败处理关系，
避免 B 提前失败而尚未被处理。

### 误区 5：forEach 会等待异步回调

不会：

```ts
toolCalls.forEach(async (call) => {
  await registry.execute(signal, call);
});

// 此处不会等待所有工具完成。
```

需要串行用 `for...of + await`；需要并发并等待全部结果，用 `Promise.all + map`。

## 十三、用一个完整例子回顾

```ts
function executeTool(name: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    console.log(`启动工具 ${name}`);

    setTimeout(() => {
      if (name === "") {
        reject(new Error("工具名不能为空"));
        return;
      }

      resolve(`工具 ${name} 完成`);
    }, 2000);
  });
}

async function main(): Promise<void> {
  try {
    const [a, b] = await Promise.all([
      executeTool("A"),
      executeTool("B"),
    ]);

    console.log(a);
    console.log(b);
  } catch (error) {
    console.error("执行失败：", error);
  }
}

main();
```

对应关系：

```text
new Promise → 创建代表操作的对象
resolve     → 交付成功结果
reject      → 交付失败原因
async       → 让函数返回 Promise
await       → 暂停当前函数，取得结果或抛出失败原因
Promise.all → 聚合多个操作的结果
```

**最重要的一句话：调用启动操作，Promise 代表操作，await 等待结果。**
