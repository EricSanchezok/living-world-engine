"use client";

import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  type TextMessagePartComponent,
} from "@assistant-ui/react";
import { ArrowDown, ArrowUp, Check, Copy, CornerDownRight } from "lucide-react";
import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  useIsPresent,
} from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useId, useState, type ReactNode } from "react";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/cn";
import { WorldTimelineRail, type TimelineEntry } from "./world-timeline";

export type ComposerMode = "available" | "suppressed";

export interface GameThreadProps {
  actionError: string;
  busy: boolean;
  composerMode: ComposerMode;
  footer?: ReactNode;
  footerKey?: string;
  readOnly?: boolean;
  reduceMotion?: boolean;
  streamWarning: string;
  suggestions?: readonly string[];
  timeline?: readonly TimelineEntry[];
  timelineStep?: number;
}

const loadMotionFeatures = () => import("./motion-features").then((module) => module.default);
const consoleTransition = {
  layout: { bounce: 0, duration: 0.3, type: "spring" },
  opacity: { duration: 0.15, ease: [0.2, 0, 0, 1] },
  y: { bounce: 0, duration: 0.3, type: "spring" },
} as const;

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
  suggestions: readonly string[];
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
            <TooltipIconButton tooltip="复制世界回复">
              <AuiIf condition={(state) => state.message.isCopied}>
                <Check aria-hidden="true" className="size-4" />
              </AuiIf>
              <AuiIf condition={(state) => !state.message.isCopied}>
                <Copy aria-hidden="true" className="size-4" />
              </AuiIf>
            </TooltipIconButton>
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
      {isLast && !busy ? <SuggestionFollowups inputId={inputId} suggestions={suggestions} /> : null}
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
  suggestions: readonly string[];
}) {
  const role = useAuiState((state) => state.message.role);
  return role === "user"
    ? <UserMessage />
    : <AssistantMessage busy={busy} inputId={inputId} suggestions={suggestions} />;
}

function useDesktopAutoFocus(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 48rem) and (pointer: fine)");
    const update = () => setEnabled(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return enabled;
}

function SuggestionFollowups({ inputId, suggestions }: { inputId: string; suggestions: readonly string[] }) {
  const aui = useAui();
  if (suggestions.length === 0) return null;
  return (
    <section aria-label="可选的行动建议" className="cg-message-suggestions">
      <ul>
        {suggestions.map((suggestion) => (
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
    </section>
  );
}

function Composer({ busy, disabled = false, inputId }: { busy: boolean; disabled?: boolean; inputId: string }) {
  const autoFocus = useDesktopAutoFocus();
  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col">
      <div className="aui-composer-shell flex w-full cursor-text items-end gap-2 rounded-3xl border border-border bg-card p-2">
        <ComposerPrimitive.Input
          aria-label="你的行动"
          autoFocus={autoFocus}
          className="max-h-48 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground/70"
          disabled={disabled}
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
              aria-label={busy ? "世界正在推演" : "发送行动"}
              className="size-8 bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
              disabled={busy || disabled}
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

function ConsoleStatusPresence({ children }: { children: ReactNode }) {
  const isPresent = useIsPresent();
  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      aria-hidden={!isPresent || undefined}
      className="cg-thread-console__item cg-thread-console__status"
      exit={{ opacity: 0, y: -4 }}
      initial={{ opacity: 0, y: 8 }}
      inert={isPresent ? undefined : true}
      layout="position"
      transition={consoleTransition}
    >
      {children}
    </m.div>
  );
}

function ComposerPresence({ busy, inputId }: { busy: boolean; inputId: string }) {
  const isPresent = useIsPresent();
  return (
    <m.div
      animate={{ opacity: 1 }}
      aria-hidden={!isPresent || undefined}
      className="cg-thread-console__item cg-thread-console__composer"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      inert={isPresent ? undefined : true}
      layout="position"
      transition={consoleTransition}
    >
      <Composer busy={busy} disabled={!isPresent} inputId={inputId} />
    </m.div>
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
  footerKey = "footer",
  readOnly = false,
  reduceMotion = false,
  streamWarning,
  suggestions = [],
  timeline = [],
  timelineStep = 0,
}: GameThreadProps) {
  const isEmpty = useAuiState((state) => state.thread.messages.length === 0);
  const inputId = useId();
  const activeSuggestions = readOnly || composerMode === "suppressed" ? [] : suggestions;
  return (
    <ThreadPrimitive.Root
      className="aui-root cg-thread-root flex h-full flex-col bg-background"
      style={{ ["--thread-max-width" as string]: "44rem" }}
    >
      <ThreadPrimitive.Viewport
        className="relative flex flex-1 flex-col overflow-x-hidden overflow-y-auto scroll-smooth"
        data-cg-thread-viewport
        turnAnchor="top"
      >
        <div className={cn(
          "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
          isEmpty && "justify-center",
        )}>
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
            <LazyMotion features={loadMotionFeatures} strict>
              <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
                <m.div className="cg-thread-console" layout transition={consoleTransition}>
                  <AnimatePresence initial={false} mode="popLayout">
                    {footer ? (
                      <ConsoleStatusPresence key={`status:${footerKey}`}>
                        {footer}
                      </ConsoleStatusPresence>
                    ) : null}
                    {!readOnly && composerMode === "available" ? (
                      <ComposerPresence busy={busy} inputId={inputId} key="composer" />
                    ) : null}
                  </AnimatePresence>
                </m.div>
              </MotionConfig>
            </LazyMotion>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
      <WorldTimelineRail entries={timeline} reducedMotion={reduceMotion} step={timelineStep} />
    </ThreadPrimitive.Root>
  );
}
