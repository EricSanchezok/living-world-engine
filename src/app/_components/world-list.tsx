"use client";

import Link from "next/link";
import { Upload } from "lucide-react";
import type { ChangeEvent } from "react";
import type { PublicInstanceSummary, WorldSummary } from "../../shared/world-api";

export function WorldList({
  busy,
  instances,
  onImport,
  selectedWorldId,
  worlds,
}: {
  busy?: string;
  instances: PublicInstanceSummary[];
  onImport: (file: File) => Promise<void>;
  selectedWorldId?: string;
  worlds: WorldSummary[];
}) {
  function selectFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file) void onImport(file).finally(() => { event.target.value = ""; });
  }
  return (
    <aside className="cg-world-sidebar" aria-label="已安装世界">
      <div className="cg-world-sidebar__heading"><p className="cg-eyebrow">本地世界</p><h2>世界包</h2></div>
      <nav className="cg-world-nav" aria-label="世界包列表">
        {worlds.map((world) => {
          const count = instances.filter((instance) => instance.worldId === world.id).length;
          return (
            <Link aria-current={world.id === selectedWorldId ? "page" : undefined}
              href={`/worlds/${encodeURIComponent(world.id)}`} key={world.id}>
              <strong>{world.name}</strong>
              <span>版本 {world.version} · {count} 个实例</span>
              <small>{world.participation === "open" ? "可进入" : "观察者开局"}</small>
            </Link>
          );
        })}
      </nav>
      <label className="cg-import-world">
        <Upload aria-hidden="true" />
        <span><strong>{busy?.startsWith("world-import:") ? "正在导入…" : "导入世界包"}</strong><small>选择世界包 ZIP</small></span>
        <input accept=".zip,application/zip" disabled={busy?.startsWith("world-import:")} onChange={selectFile} type="file" />
      </label>
    </aside>
  );
}
