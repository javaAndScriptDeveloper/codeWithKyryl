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

# Windows and JRuby specific gems
platforms :mingw, :x64_mingw, :mswin, :jruby do
  gem "tzinfo", ">= 1", "< 3"
  gem "tzinfo-data"
end

# Performance-booster for watching directories on Windows
gem "wdm", "~> 0.1.1", :platforms => [:mingw, :x64_mingw, :mswin]

# Lock `http_parser.rb` gem to `v0.6.x` on JRuby builds
gem "http_parser.rb", "~> 0.6.0", :platforms => [:jruby]