# Upload TerminalFlow's website

This is a static website. It needs no build step, Node.js, PHP, database, or API keys.

1. Point `terminalflowapp.com` at your hosting provider and enable HTTPS.
2. Upload `index.html`, `styles.css`, `favicon.svg`, `robots.txt`, `sitemap.xml`, and the `assets` folder to the domain's document root (often `public_html`). Upload the contents of this folder, rather than the `website` folder itself.
3. Open `https://terminalflowapp.com/` and check the images and download buttons.

The upload ZIP contains only the public website files. Keep this guide outside the public document root.

To preview locally, run from this folder:

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080`. Stop the server with Ctrl+C.

Run the small local check with `python3 check.py`. This verifies local assets, page navigation, image descriptions, and the three platform download destinations. Keep `check.py` outside the public document root too.

Downloads point to the latest GitHub release assets. If release asset filenames change, update the three download links in `index.html`. The Claude assistant is labelled as planned; update that section when it becomes available.

All fonts and images are served locally or provided by the visitor's system. The site uses no JavaScript, analytics, forms, or third-party embeds. The app source remains in the repository root.
