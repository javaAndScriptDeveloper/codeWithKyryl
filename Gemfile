source "https://rubygems.org"

# GitHub Pages compatible Jekyll version
gem "github-pages", group: :jekyll_plugins

# Or if you want to use latest Jekyll (not GitHub Pages compatible)
# gem "jekyll", "~> 4.3.0"

# Essential Jekyll plugins
group :jekyll_plugins do
  gem "jekyll-feed"
  gem "jekyll-sitemap"
  gem "jekyll-seo-tag"
  gem "jekyll-paginate"
  gem "jekyll-archives"
  gem "jekyll-redirect-from"
end

# Development dependencies
group :development do
  gem "webrick" # Required for Ruby 3.0+
end

# Production-only: auto-generates per-post Open Graph share images at build time.
# Kept OUT of the :jekyll_plugins group on purpose — that group is auto-loaded by
# Jekyll, and this plugin pulls in ruby-vips which needs libvips at runtime. libvips
# ships in the Netlify build image but not necessarily on a dev machine, so it's only
# wired in via _config_production.yml (see netlify.toml). Local `jekyll serve` never
# loads it. To test OG generation locally: install libvips, then build with
#   bundle exec jekyll build --config _config.yml,_config_production.yml
group :production do
  gem "jekyll-og-image"
end

# Windows and JRuby specific gems
platforms :mingw, :x64_mingw, :mswin, :jruby do
  gem "tzinfo", ">= 1", "< 3"
  gem "tzinfo-data"
end

# Performance-booster for watching directories on Windows
gem "wdm", "~> 0.1.1", :platforms => [:mingw, :x64_mingw, :mswin]

# Lock `http_parser.rb` gem to `v0.6.x` on JRuby builds
gem "http_parser.rb", "~> 0.6.0", :platforms => [:jruby]