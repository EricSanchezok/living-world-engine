"use client";

import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useThreadViewportStore,
  type TextMessagePartComponent,
} from "@assistant-ui/react";
import { ArrowDown, ArrowUp, Check, Copy, CornerDownRight, Lightbulb, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/cn";
import type { PublicActionSuggestions } from "../../shared/world-api";
import { WorldTimelineRail, type TimelineEntry } from "./world-timeline";

export type ComposerMode = "available" | "suppressed";

export interface SuggestionControl {
  state: PublicActionSuggestions;
  pending: boolean;
  error: string;
  onRequest: () => void;
}

export interface GameThreadProps {
  actionError: string;
  busy: boolean;
  composerMode: ComposerMode;
  footer?: ReactNode;
  readOnly?: boolean;
  observerName?: string;
  reduceMotion?: boolean;
  streamWarning: string;
  suggestions?: SuggestionControl;
  timeline?: readonly TimelineEntry[];
  timelineStep?: number;
}

const MessageText: TextMessagePartComponent = ({ text }) => {
  const temporalMarker = /\n\n世界时间 ([^\n]+?)(?: · ([^\n]+))?$/u;
  const match = text.match(temporalMarker);
  const narrative = match ? text.slice(0, match.index) : text;
  return (
    <>
      <p className="cg-narrative whitespace-pre-wrap">{narrative}</p>
      {match ? <p className="cg-narrative__meta">世界时间 {match[1]}{match[2] ? ` · ${match[2]}` : ""}</p> : null}
    </>
  );
};

function UserMessage() {
  const id = useAuiState((state) => state.message.id);
  return (
    <MessagePrimitive.Root
      className="animate-in fade-in slide-in-from-bottom-1 flex w-full justify-end px-2 duration-150 motion-reduce:animate-none"
      data-role="user"
      id={id}
    >
      <div className="aui-user-message-bubble">
        <MessagePrimitive.Parts components={{ Text: MessageText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({
  busy,
  inputId,
  suggestions,
}: {
  busy: boolean;
  inputId: string;
  suggestions?: SuggestionControl;
}) {
  const id = useAuiState((state) => state.message.id);
  const isLast = useAuiState((state) => state.message.isLast);
  const worldTime = useAuiState((state) => state.message.metadata.custom.worldTimeSeconds);
  const activityStage = useAuiState((state) => state.message.metadata.custom.activityStage);
  return (
    <MessagePrimitive.Root
      className="animate-in fade-in slide-in-from-bottom-1 relative duration-150 motion-reduce:animate-none"
      data-cg-timeline-id={id}
      data-role="assistant"
      id={id}
    >
      <div className="cg-assistant-message">
        <MessagePrimitive.Parts components={{ Text: MessageText }} />
      </div>
      {typeof worldTime === "number" ? <p className="cg-muted mt-2 text-xs">世界时间 {worldTime}s{typeof activityStage === "string" ? ` · ${activityStage}` : ""}</p> : null}
      <div className="ms-2 flex min-h-7.5 items-center pt-1.5">
        <ActionBarPrimitive.Root
          autohide="never"
          className="animate-in fade-in -ms-1 flex gap-1 text-muted-foreground duration-150 motion-reduce:animate-none"
        >
          <ActionBarPrimitive.Copy asChild>
            <TooltipIconButton className="cg-message-copy" tooltip="复制世界回复">
              <AuiIf condition={(state) => state.message.isCopied}>
                <Check aria-hidden="true" className="size-4" />
              </AuiIf>
              <AuiIf condition={(state) => !state.message.isCopied}>
                <Copy aria-hidden="true" className="size-4" />
              </AuiIf>
            </TooltipIconButton>
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
        {isLast && !busy && suggestions ? <SuggestionTrigger control={suggestions} /> : null}
      </div>
      {isLast && !busy && suggestions ? <SuggestionFollowups inputId={inputId} suggestions={suggestions} /> : null}
    </MessagePrimitive.Root>
  );
}

function ThreadMessage({
  busy,
  inputId,
  suggestions,
}: {
  busy: boolean;
  inputId: string;
  suggestions?: SuggestionControl;
}) {
  const role = useAuiState((state) => state.message.role);
  return role === "user"
    ? <UserMessage />
    : <AssistantMessage busy={busy} inputId={inputId} suggestions={suggestions} />;
}

function SuggestionTrigger({ control }: { control: SuggestionControl }) {
  const hasDraft = useAuiState((state) => state.thread.composer.text.trim().length > 0);
  if (hasDraft) return null;
  const pending = control.pending || control.state.status === "generating";
  const replacing = control.state.items.length > 0;
  return (
    <button aria-busy={pending} className="cg-suggestion-trigger" disabled={pending} onClick={control.onRequest} type="button">
      {pending ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        : replacing ? <RefreshCw aria-hidden="true" /> : <Lightbulb aria-hidden="true" />}
      {pending ? "生成中…" : replacing ? "换一组" : "行动建议"}
    </button>
  );
}

function SuggestionFollowups({ inputId, suggestions }: { inputId: string; suggestions: SuggestionControl }) {
  const aui = useAui();
  const hasDraft = useAuiState((state) => state.thread.composer.text.trim().length > 0);
  if (hasDraft) return null;
  const { state, pending, error } = suggestions;
  const failed = !pending && state.status !== "generating" && (error || state.status === "failed");
  const empty = !pending && state.status === "ready" && state.items.length === 0;
  if (!state.items.length && !failed && !empty) return null;
  return (
    <section aria-label="可选的行动建议" className="cg-message-suggestions">
      <ul>
        {state.items.map((suggestion) => (
          <li key={suggestion}>
            <button
              aria-label={suggestion}
              className="cg-message-suggestion"
              onClick={() => {
                aui.thread.composer().setText(suggestion);
                document.getElementById(inputId)?.focus();
              }}
              type="button"
            >
              <CornerDownRight aria-hidden="true" />
              <span>{suggestion}</span>
            </button>
          </li>
        ))}
      </ul>
      {failed || empty ? <p className="cg-suggestion-feedback" role="status">
        {failed ? "建议暂时没能生成，可以再试一次。" : "暂时没有其他合适的建议，可以继续输入行动。"}
      </p> : null}
    </section>
  );
}

function Composer({ busy, inputId, onSubmit }: { busy: boolean; inputId: string; onSubmit: () => void }) {
  const viewport = useThreadViewportStore();
  const beforeSend = () => {
    onSubmit();
    viewport.getState().scrollToBottom({ behavior: "instant" });
  };
  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col" onSubmitCapture={beforeSend}>
      <div className="cg-composer-content flex w-full cursor-text items-end gap-2 p-2">
        <ComposerPrimitive.Input
          aria-label="你的行动"
          className="max-h-48 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2 text-base leading-6 text-foreground placeholder:text-muted-foreground/70"
          enterKeyHint="send"
          id={inputId}
          maxLength={4000}
          placeholder="自由描述你的行动…"
          rows={1}
          submitMode="enter"
          unstable_insertNewlineOnTouchEnter
        />
        <div className="flex min-h-10 items-center justify-end">
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              onClickCapture={beforeSend}
              aria-label={busy ? "世界正在推演" : "发送行动"}
              className="size-8 bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
              disabled={busy}
              tooltip={busy ? "世界正在推演" : "发送行动"}
            >
              <ArrowUp aria-hidden="true" className="size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function ScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        className="absolute -top-12 z-10 self-center border bg-background disabled:invisible"
        tooltip="滚动到最新消息"
      >
        <ArrowDown aria-hidden="true" className="size-4" />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
}

export function GameThread({
  actionError,
  busy,
  composerMode,
  footer,
  readOnly = false,
  observerName,
  reduceMotion = false,
  streamWarning,
  suggestions,
  timeline = [],
  timelineStep = 0,
}: GameThreadProps) {
  const isEmpty = useAuiState((state) => state.thread.messages.length === 0);
  const inputId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const editableHeight = useRef(64);
  const initialFocusHandled = useRef(false);
  const canCompose = !readOnly && composerMode === "available";

  useLayoutEffect(() => {
    const footer = footerRef.current;
    const root = rootRef.current;
    if (!footer || !root) return;
    const measure = () => root.style.setProperty("--cg-thread-footer-height", `${footer.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.style.height = canCompose ? "" : `${editableHeight.current}px`;
    if (!canCompose) return;
    const measure = () => { editableHeight.current = frame.getBoundingClientRect().height; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [canCompose, readOnly]);

  useEffect(() => {
    if (!canCompose || initialFocusHandled.current) return;
    initialFocusHandled.current = true;
    if (document.activeElement === document.body && window.matchMedia("(min-width: 48rem) and (pointer: fine)").matches) {
      document.getElementById(inputId)?.focus({ preventScroll: true });
    }
  }, [canCompose, inputId]);

  const captureSubmission = () => {
    if (frameRef.current) editableHeight.current = frameRef.current.getBoundingClientRect().height;
  };
  const activeSuggestions = readOnly || composerMode === "suppressed" ? undefined : suggestions;
  return (
    <ThreadPrimitive.Root
      className="aui-root cg-thread-root flex h-full flex-col bg-background"
      ref={rootRef}
      data-reduce-motion={reduceMotion || undefined}
      style={{ ["--thread-max-width" as string]: "44rem" }}
    >
      <ThreadPrimitive.Viewport
        className="relative flex flex-1 flex-col overflow-x-hidden overflow-y-auto"
        data-cg-thread-viewport
        turnAnchor="bottom"
        scrollToBottomOnRunStart={false}
      >
        <div className={cn(
          "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
          isEmpty && "justify-center",
        )}>
          {readOnly && observerName ? <header className="cg-observer-heading">
            <p>正在观察 · {observerName}</p>
            <span>这里记录这个角色的行动与见闻；世界中的其他角色也会同时行动。</span>
          </header> : null}
          {isEmpty ? (
            <section className="mb-6 flex flex-col items-center px-4 text-center">
              <h2 className="text-2xl font-medium tracking-tight">
                {readOnly ? "这个角色还没有留下可见经历" : "你想做什么？"}
              </h2>
            </section>
          ) : null}
          <div className="cg-thread-messages flex flex-col gap-y-6 empty:hidden">
            <ThreadPrimitive.Messages>{() => (
              <ThreadMessage busy={busy} inputId={inputId} suggestions={activeSuggestions} />
            )}</ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter
            ref={footerRef}
            data-docked={!isEmpty}
            data-slot="aui-thread-viewport-footer"
            className={cn(
              "cg-safe-area-bottom cg-thread-footer relative flex flex-col gap-3 overflow-visible bg-background md:pb-6",
              !isEmpty && "rounded-t-3xl",
            )}
          >
            <ScrollToBottom />
            <div
              aria-live="polite"
              className={cn("cg-thread-status-message", !streamWarning && "cg-sr-only")}
              role="status"
            >
              {streamWarning}
            </div>
            {actionError ? (
              <div className="cg-thread-error" role="alert">
                {actionError}
              </div>
            ) : null}
            <div className="cg-thread-console">
              {readOnly ? footer : (
                <div className="aui-composer-shell cg-thread-console__frame" ref={frameRef}>
                  <div className="cg-thread-console__content" data-mode={canCompose ? "input" : "progress"} key={canCompose ? "input" : "progress"}>
                    {footer ? <div className="cg-thread-console__status">{footer}</div> : null}
                    {canCompose ? <Composer busy={busy} inputId={inputId} onSubmit={captureSubmission} /> : null}
                  </div>
                </div>
              )}
            </div>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
      <WorldTimelineRail entries={timeline} reducedMotion={reduceMotion} step={timelineStep} />
    </ThreadPrimitive.Root>
  );
}
