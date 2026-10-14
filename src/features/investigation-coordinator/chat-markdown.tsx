"use client";

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

function safeUrl(url: string) {
  const safe = defaultUrlTransform(url);
  if (safe.startsWith("#")) return safe;
  if (/^mailto:/i.test(safe)) return safe;
  if (!/^https?:\/\//i.test(safe)) return "";
  try {
    return new URL(safe).hostname ? safe : "";
  } catch {
    return "";
  }
}

export function ChatMarkdown({ text, messageId }: { text: string; messageId: string }) {
  const prefix = `chat-${messageId}-`;
  const labelId = `${prefix}footnote-label`;
  return (
    <div className="mt-1 min-w-0 max-w-full space-y-3 text-sm leading-relaxed [overflow-wrap:anywhere] [&_p]:whitespace-pre-wrap [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_li>ul]:mt-1 [&_li>ol]:mt-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-600 [&_code]:rounded [&_code]:bg-neutral-100 [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_th]:border [&_th]:bg-neutral-50 [&_th]:px-3 [&_th]:py-2 [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_input]:mr-1 [&_.contains-task-list]:list-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{ clobberPrefix: prefix }}
        skipHtml
        urlTransform={safeUrl}
        components={{
          a: ({
            href,
            children,
            id,
            title,
            "aria-label": ariaLabel,
            "aria-describedby": describedBy,
            ...attributes
          }) =>
            href ? (
              <a
                href={href}
                id={id}
                title={title}
                aria-label={ariaLabel}
                aria-describedby={describedBy
                  ?.split(/\s+/)
                  .map((target) => (target === "footnote-label" ? labelId : target))
                  .join(" ")}
                data-footnote-ref={
                  "data-footnote-ref" in attributes ? attributes["data-footnote-ref"] : undefined
                }
                data-footnote-backref={
                  "data-footnote-backref" in attributes
                    ? attributes["data-footnote-backref"]
                    : undefined
                }
                target={href.startsWith("#") ? undefined : "_blank"}
                rel={href.startsWith("#") ? undefined : "noopener noreferrer"}
                className="text-blue-700 underline underline-offset-2"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          h2: ({ id, className, children }) => (
            <h2 id={id === "footnote-label" ? labelId : id} className={className}>
              {children}
            </h2>
          ),
          img: ({ alt }) => <span className="text-neutral-500">[이미지: {alt || "이미지"}]</span>,
          pre: ({ children }) => (
            <pre className="min-w-0 max-w-full overflow-x-auto rounded-md bg-neutral-100 p-3 whitespace-pre [overflow-wrap:normal]">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="min-w-0 max-w-full overflow-x-auto">
              <table className="w-max min-w-full border-collapse text-left text-xs">
                {children}
              </table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
