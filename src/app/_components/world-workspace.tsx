"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { CreateInstanceInput } from "../../shared/world-api";
import { useWorldLibrary } from "./use-world-library";
import { WorldDetail } from "./world-detail";
import { WorldList } from "./world-list";

export function WorldWorkspace({ selectedWorldId }: { selectedWorldId?: string }) {
  const router = useRouter();
  const library = useWorldLibrary();
  const selected = library.worlds.find((world) => world.id === (selectedWorldId ?? library.worlds[0]?.id));
  async function create(input: CreateInstanceInput) {
    const detail = await library.createInstance(input);
    router.push(`/play/${encodeURIComponent(detail.summary.id)}`);
  }
  return (
    <main className="cg-world-workspace" data-world-selected={Boolean(selectedWorldId && selected) || undefined}>
      <header className="cg-workspace-bar"><Link className="cg-back-link" href="/"><ArrowLeft aria-hidden="true" />主菜单</Link><span>世界包与实例</span></header>
      <div className="cg-world-workspace__body">
        <WorldList busy={library.busy} instances={library.instances} onImport={async (file) => {
          const result = await library.importWorld(file);
          router.push(`/worlds/${encodeURIComponent(result.id)}`);
        }} selectedWorldId={selected?.id} worlds={library.worlds} />
        <div className="cg-world-workspace__content">
          <div className="cg-feedback">{library.error ? <p className="cg-alert" role="alert">{library.error}</p> : null}</div>
          {library.loading ? <div className="cg-workspace-empty" role="status">正在读取本地世界…</div> : null}
          {!library.loading && selected ? <WorldDetail busy={library.busy} instances={library.instances.filter((item) => item.worldId === selected.id)}
            onCreateInstance={create} onDeleteInstance={library.deleteInstance} onDeleteWorld={async (world) => {
              await library.deleteWorld(world); router.replace("/worlds");
            }} world={selected} /> : null}
          {!library.loading && library.worlds.length === 0 ? <div className="cg-workspace-empty"><h1>还没有安装世界包</h1><p>导入世界包 ZIP 后即可开始游戏。</p></div> : null}
        </div>
      </div>
      <div className="cg-toast-region" role="status">
        {library.notice ? <p className="cg-toast">{library.notice}</p> : null}
      </div>
    </main>
  );
}
