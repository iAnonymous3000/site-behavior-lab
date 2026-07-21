import { publicPageMetadata } from "@/lib/seo-metadata";
import { DirectoryIndex } from "./directory-index";

export const dynamic = "force-static";

export const metadata = publicPageMetadata({
  title: "Directory of scanned sites",
  description:
    "Browse one current evidence profile per scanned site, with controlled-visit reports, dates, categories and versioned researcher exports.",
  path: "/directory/"
});

export default function DirectoryPage() {
  return <DirectoryIndex page={1} />;
}
