/* BotGuild Agents docs reader.
 * Renders the repo's markdown guides client-side — single source of truth,
 * no build step. Markdown files are served at the site root (the Pages
 * artifact root is the repo's docs/ folder), so a doc "route" is the file's
 * path relative to docs/, e.g. "flyio/steps.md". A section is appended after
 * a "~", e.g. "#flyio/steps.md~5-set-per-app-secrets".
 */
(function () {
  'use strict';

  var REPO = 'https://github.com/botguild/botguild-agents';
  var BRANCH = 'develop';

  // In-site docs (markdown under docs/, fetched and rendered here). Order is
  // also the prev/next sequence.
  var GUIDE = [
    { route: 'build-your-own-bot.md', title: 'Build Your Own Bot' },
    { route: 'flyio/steps.md', title: 'Deploy to Fly.io' },
    { route: 'cicd/gitflow.md', title: 'Branching & Gitflow' },
    { route: 'roadmap.md', title: 'Roadmap' },
  ];
  // Reference docs that live outside docs/ — linked out to GitHub.
  var REFERENCE = [
    { url: REPO + '/blob/' + BRANCH + '/packages/agent-core/README.md', title: 'agent-core API' },
    { url: REPO + '/tree/' + BRANCH + '/apps/starter-bot', title: 'starter-bot' },
    { url: REPO + '/blob/' + BRANCH + '/CONTRIBUTING.md', title: 'Contributing' },
    { url: REPO + '/blob/' + BRANCH + '/SECURITY.md', title: 'Security' },
    { url: REPO + '/blob/' + BRANCH + '/CODE_OF_CONDUCT.md', title: 'Code of Conduct' },
  ];
  var DEFAULT_ROUTE = GUIDE[0].route;

  var contentEl = document.getElementById('doc-content');
  var navEl = document.getElementById('sidebar-nav');
  var footEl = document.getElementById('doc-footer-nav');
  var searchEl = document.getElementById('search');

  var cache = {}; // route -> markdown text
  var currentRoute = null;
  var searchIndex = null;

  // ---------- helpers ----------
  function esc(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function slugify(s) {
    return s
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  // Resolve a relative href against a repo-relative base directory,
  // collapsing "." and "..".
  function resolveRepoPath(baseDir, href) {
    var parts = href.charAt(0) === '/' ? [] : baseDir ? baseDir.split('/') : [];
    href
      .replace(/^\//, '')
      .split('/')
      .forEach(function (seg) {
        if (seg === '..') parts.pop();
        else if (seg !== '.' && seg !== '') parts.push(seg);
      });
    return parts.join('/');
  }

  function titleFor(route) {
    for (var i = 0; i < GUIDE.length; i++) if (GUIDE[i].route === route) return GUIDE[i].title;
    // Unlisted in-site doc (e.g. a roadmap story) — derive from filename.
    var base = route.split('/').pop().replace(/\.md$/, '').replace(/[-_]/g, ' ');
    return base.replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  // ---------- link & heading rewriting ----------
  function rewriteLinks(container, route) {
    var baseDir = ('docs/' + route).split('/').slice(0, -1).join('/');
    var links = container.querySelectorAll('a[href]');
    Array.prototype.forEach.call(links, function (a) {
      var href = a.getAttribute('href');
      if (!href) return;

      if (href.charAt(0) === '#') {
        // In-page anchor → route to this doc's section.
        a.setAttribute('href', '#' + route + '~' + href.slice(1));
        return;
      }
      if (/^(https?:|mailto:)/.test(href)) {
        if (/^https?:/.test(href)) {
          a.target = '_blank';
          a.rel = 'noopener';
        }
        return;
      }

      // Relative link — split off any fragment, resolve to a repo path.
      var hash = '';
      var hi = href.indexOf('#');
      if (hi !== -1) {
        hash = href.slice(hi + 1);
        href = href.slice(0, hi);
      }
      var p = resolveRepoPath(baseDir, href);

      if (p.indexOf('docs/') === 0 && /\.md$/.test(p)) {
        // Another in-site doc.
        a.setAttribute('href', '#' + p.slice(5) + (hash ? '~' + hash : ''));
      } else {
        // Lives outside docs/ — link to GitHub. File → blob, dir → tree.
        var last = p.split('/').pop();
        var kind = last.indexOf('.') !== -1 ? 'blob' : 'tree';
        a.setAttribute(
          'href',
          REPO + '/' + kind + '/' + BRANCH + '/' + p + (hash ? '#' + hash : ''),
        );
        a.target = '_blank';
        a.rel = 'noopener';
      }
    });
  }

  // Give headings stable ids + hover anchors; return the h2 outline for a TOC.
  function enhanceHeadings(container, route) {
    var used = {};
    var toc = [];
    var heads = container.querySelectorAll('h2, h3');
    Array.prototype.forEach.call(heads, function (h) {
      var id = slugify(h.textContent);
      if (!id) return;
      if (used[id]) {
        used[id]++;
        id = id + '-' + used[id];
      } else {
        used[id] = 1;
      }
      h.id = id;
      var anchor = document.createElement('a');
      anchor.className = 'anchor';
      anchor.href = '#' + route + '~' + id;
      anchor.textContent = '#';
      anchor.setAttribute('aria-label', 'Link to this section');
      h.appendChild(anchor);
      if (h.tagName === 'H2') toc.push({ id: id, text: h.textContent.replace(/#$/, '') });
    });
    return toc;
  }

  function tocBox(toc, route) {
    if (toc.length < 3) return '';
    var items = toc
      .map(function (t) {
        return '<li><a href="#' + route + '~' + t.id + '">' + esc(t.text) + '</a></li>';
      })
      .join('');
    return (
      '<details class="toc-box" open style="margin:0 0 28px;border:1px solid var(--border-soft);' +
      'border-radius:12px;padding:10px 16px;background:var(--bg-soft)">' +
      '<summary style="cursor:pointer;color:var(--faint);font-size:13px;' +
      'font-family:var(--mono);letter-spacing:.06em;text-transform:uppercase">On this page</summary>' +
      '<ul style="margin:10px 0 4px;padding-left:18px;font-size:14px">' +
      items +
      '</ul></details>'
    );
  }

  // ---------- rendering ----------
  function fetchDoc(route) {
    if (cache[route] != null) return Promise.resolve(cache[route]);
    return fetch(route, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (txt) {
        cache[route] = txt;
        return txt;
      });
  }

  function renderDoc(route) {
    contentEl.innerHTML = '<p class="loading">Loading…</p>';
    return fetchDoc(route)
      .then(function (md) {
        var html = marked.parse(md);
        contentEl.innerHTML = html;
        rewriteLinks(contentEl, route);
        var toc = enhanceHeadings(contentEl, route);
        // Insert the "On this page" box after the leading <h1> if present.
        if (toc.length >= 3) {
          var box = document.createElement('div');
          box.innerHTML = tocBox(toc, route);
          var h1 = contentEl.querySelector('h1');
          if (h1 && h1.nextSibling) contentEl.insertBefore(box.firstChild, h1.nextSibling);
          else if (h1) contentEl.appendChild(box.firstChild);
          else contentEl.insertBefore(box.firstChild, contentEl.firstChild);
        }
        currentRoute = route;
        document.title = titleFor(route) + ' — BotGuild Agents';
        renderFooterNav(route);
      })
      .catch(function (err) {
        contentEl.innerHTML =
          '<h1>Not found</h1><p class="loading">Could not load <code>' +
          esc(route) +
          '</code> (' +
          esc(err.message) +
          '). ' +
          '<a href="#' +
          DEFAULT_ROUTE +
          '">Back to the guide →</a></p>';
        footEl.hidden = true;
      });
  }

  function renderFooterNav(route) {
    var idx = -1;
    for (var i = 0; i < GUIDE.length; i++) if (GUIDE[i].route === route) idx = i;
    if (idx === -1) {
      footEl.hidden = true;
      return;
    }
    var prev = GUIDE[idx - 1],
      next = GUIDE[idx + 1];
    var html = '';
    html += prev
      ? '<a href="#' +
        prev.route +
        '"><span class="dir">← Previous</span><span class="ttl">' +
        esc(prev.title) +
        '</span></a>'
      : '<span></span>';
    html += next
      ? '<a class="next" href="#' +
        next.route +
        '"><span class="dir">Next →</span><span class="ttl">' +
        esc(next.title) +
        '</span></a>'
      : '<span></span>';
    footEl.innerHTML = html;
    footEl.hidden = false;
  }

  // ---------- sidebar ----------
  function buildSidebar() {
    var html = '<div class="nav-group"><p class="grp-title">Guide</p>';
    GUIDE.forEach(function (d) {
      html += '<a data-route="' + d.route + '" href="#' + d.route + '">' + esc(d.title) + '</a>';
    });
    html += '</div><div class="nav-group"><p class="grp-title">Reference</p>';
    REFERENCE.forEach(function (d) {
      html +=
        '<a href="' +
        d.url +
        '" target="_blank" rel="noopener">' +
        esc(d.title) +
        '<span class="ext">↗</span></a>';
    });
    html += '</div>';
    navEl.innerHTML = html;
  }

  function setActive(route) {
    var links = navEl.querySelectorAll('a[data-route]');
    Array.prototype.forEach.call(links, function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === route);
    });
  }

  // ---------- search ----------
  function buildSearchIndex() {
    return Promise.all(
      GUIDE.map(function (d) {
        return fetchDoc(d.route).then(function (md) {
          return { doc: d, md: md };
        });
      }),
    ).then(function (docs) {
      var sections = [];
      docs.forEach(function (entry) {
        var route = entry.doc.route;
        // Split on h2 headings; keep a synthetic intro section for the top.
        var lines = entry.md.split('\n');
        var cur = {
          route: route,
          docTitle: entry.doc.title,
          heading: entry.doc.title,
          id: '',
          body: '',
        };
        lines.forEach(function (ln) {
          var m = /^##\s+(.*)$/.exec(ln);
          if (m) {
            if (cur.body.trim() || cur.id === '') sections.push(cur);
            var h = m[1].replace(/[#*`]/g, '').trim();
            cur = { route: route, docTitle: entry.doc.title, heading: h, id: slugify(h), body: '' };
          } else if (!/^#{1,3}\s/.test(ln)) {
            cur.body += ln + ' ';
          }
        });
        sections.push(cur);
      });
      searchIndex = sections;
    });
  }

  function snippet(body, q) {
    var lc = body.toLowerCase();
    var i = lc.indexOf(q.toLowerCase());
    if (i === -1) return esc(body.slice(0, 120).trim());
    var start = Math.max(0, i - 40);
    var raw = (start > 0 ? '…' : '') + body.slice(start, i + q.length + 60).trim() + '…';
    // Escape, then highlight the (escaped) query.
    var out = esc(raw);
    var eq = esc(q);
    var re = new RegExp(eq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    return out.replace(re, function (m) {
      return '<mark>' + m + '</mark>';
    });
  }

  function runSearch(q) {
    if (!q || q.length < 2) {
      buildSidebar();
      setActive(currentRoute);
      return;
    }
    if (!searchIndex) {
      navEl.innerHTML =
        '<div class="nav-group"><p class="grp-title">Search</p>' +
        '<p style="color:var(--faint);font-size:13px;padding:0 10px">Indexing…</p></div>';
      return;
    }
    var lc = q.toLowerCase();
    var hits = searchIndex
      .filter(function (s) {
        return (
          s.heading.toLowerCase().indexOf(lc) !== -1 || s.body.toLowerCase().indexOf(lc) !== -1
        );
      })
      .slice(0, 24);

    if (!hits.length) {
      navEl.innerHTML =
        '<div class="nav-group"><p class="grp-title">Search</p>' +
        '<p style="color:var(--faint);font-size:13px;padding:0 10px">No results for “' +
        esc(q) +
        '”.</p></div>';
      return;
    }
    var html =
      '<div class="nav-group search-results"><p class="grp-title">' +
      hits.length +
      ' result' +
      (hits.length === 1 ? '' : 's') +
      '</p>';
    hits.forEach(function (s) {
      var href = '#' + s.route + (s.id ? '~' + s.id : '');
      html +=
        '<a class="search-hit" href="' +
        href +
        '">' +
        '<span class="hit-doc">' +
        esc(s.docTitle) +
        '</span><br>' +
        '<span class="hit-head">' +
        esc(s.heading) +
        '</span><br>' +
        '<span class="hit-snip">' +
        snippet(s.body, q) +
        '</span></a>';
    });
    html += '</div>';
    navEl.innerHTML = html;
  }

  // ---------- routing ----------
  function scrollToSection(id) {
    var el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onRoute() {
    var raw = decodeURIComponent(location.hash.slice(1));
    var sep = raw.indexOf('~');
    var route = sep === -1 ? raw : raw.slice(0, sep);
    var section = sep === -1 ? '' : raw.slice(sep + 1);
    if (!route) route = DEFAULT_ROUTE;

    var p = route === currentRoute ? Promise.resolve() : renderDoc(route);
    p.then(function () {
      setActive(route);
      if (section)
        setTimeout(function () {
          scrollToSection(section);
        }, 30);
      else window.scrollTo({ top: 0 });
    });
  }

  // ---------- init ----------
  if (typeof marked === 'undefined') {
    contentEl.innerHTML =
      '<h1>Failed to load</h1><p class="loading">The markdown renderer ' +
      'did not load. Try a hard refresh.</p>';
    return;
  }
  marked.use({ gfm: true, breaks: false });

  buildSidebar();
  var t;
  searchEl.addEventListener('input', function () {
    clearTimeout(t);
    var v = searchEl.value;
    t = setTimeout(function () {
      runSearch(v);
    }, 120);
  });
  // Build the search index lazily in the background.
  buildSearchIndex().then(function () {
    if (searchEl.value) runSearch(searchEl.value);
  });
  window.addEventListener('hashchange', onRoute);
  onRoute();
})();
