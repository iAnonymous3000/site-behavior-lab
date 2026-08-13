import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadCorpusOverview } from "@/lib/corpus-overview";
import { buildDirectorySites, directoryPageCount } from "@/lib/directory-view";
import { publicPageMetadata } from "@/lib/seo-metadata";
import { siteUrl } from "@/lib/site-url";
import { DirectoryIndex, directoryPath } from "../../directory-index";

export const dynamic = "force-static";
export const dynamicParams = false;

export async function generateStaticParams() {
  const { entries } = await loadCorpusOverview();
  const count = directoryPageCount(buildDirectorySites(entries).length);
  return Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({ page: String(index + 2) }));
}

export async function generateMetadata({ params }: { params: Promise<{ page: string }> }): Promise<Metadata> {
  const page = Number((await params).page);
  if (!Number.isInteger(page) || page < 2) {
    return {
      title: "Directory page not found",
      alternates: { canonical: null },
      robots: { index: false, follow: false }
    };
  }
  // These routes stay reachable so nothing already linked or indexed 404s, but
  // the directory is one sortable table now and they render all of it, so the
  // canonical is /directory/ rather than this slice's former URL.
  return {
    ...publicPageMetadata({
      title: `Scanned sites directory, page ${page}`,
      description: `Browse current Site Behavior Lab evidence profiles for scanned sites, directory page ${page}.`,
      path: directoryPath(page)
    }),
    alternates: { canonical: siteUrl("/directory/") }
  };
}

export default async function PaginatedDirectoryPage({ params }: { params: Promise<{ page: string }> }) {
  const page = Number((await params).page);
  if (!Number.isInteger(page) || page < 2) notFound();
  return <DirectoryIndex page={page} />;
}
