"""Check the static site's files, navigation, and download destinations."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids, self.links, self.images = [], [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if "href" in attrs:
            self.links.append(attrs["href"])
        if tag == "img":
            assert attrs.get("alt"), "Image is missing alt text"
            self.images.append(attrs["src"])


root = Path(__file__).resolve().parent
page = Page()
page.feed((root / "index.html").read_text())
assert len(page.ids) == len(set(page.ids)), "Duplicate navigation targets"
for url in page.links + page.images:
    parts = urlsplit(url)
    if not parts.scheme and not parts.netloc:
        if parts.path:
            assert (root / parts.path).is_file(), f"Missing local asset: {url}"
        elif parts.fragment:
            assert parts.fragment in page.ids, f"Broken navigation: {url}"
downloads = [url for url in page.links if "/latest/download/" in url]
assert len(downloads) == 3, "Expected downloads for three platforms"
assert all(url.startswith("https://github.com/mzgs/terminal-flow/") for url in downloads)
print("Site checks passed: local assets, navigation, image descriptions, and platform downloads.")
