import { useState } from "react";
import type { RecognitionOutput } from "../../../../games/arknights/recognition";
export default function RecognitionResult({
  output,
}: {
  output: RecognitionOutput;
}) {
  const [message, setMessage] = useState("");
  return (
    <details className="recognition-output">
      <summary>原生识别结果 · {output.events.length}份输出</summary>
      <p className="helper">
        对应原生任务编号 {output.taskId}
        。以下为当前扫描输出，尚未独立实机认证；缺少的数据不推断为0，也不用于授予执行权限。
      </p>
      {output.truncated && (
        <p className="helper">部分输出超过展示预算，未记录完整结果。</p>
      )}
      {output.events.map((e, i) => (
        <details key={i}>
          <summary>{e.name}</summary>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 360,
              overflow: "auto",
            }}
          >
            {JSON.stringify(e.details, null, 2)}
          </pre>
        </details>
      ))}
      <button
        className="button"
        onClick={() =>
          void navigator.clipboard
            .writeText(JSON.stringify(output, null, 2))
            .then(() => setMessage("识别结果已复制。"))
            .catch(() => setMessage("复制未完成，请从上方查看结果。"))
        }
      >
        复制识别结果
      </button>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
