ESY__BUILD_CACHE_URL_PREFIX="https://github.com/andreypopp/esy/releases/download/build-cache"
ESY__BUILD_CACHE_URL="$ESY__BUILD_CACHE_URL_PREFIX/$cur__install_key.tar.gz"

esy-build-download-status () {
  curl                            \
    -s                            \
    -o /dev/null                  \
    -w "%{http_code}"             \
    -I "$ESY__BUILD_CACHE_URL"
}

esy-build-download () {
  cd $esy__store/_install
  wget                \
    --tries 10        \
    --timestamping    \
    --show-progress   \
    --quiet           \
    "$ESY__BUILD_CACHE_URL"
  tar -xzf $cur__install_key.tar.gz
}

esy-prepare-install-tree () {
  mkdir -p          \
    $cur__install   \
    $cur__lib       \
    $cur__bin       \
    $cur__sbin      \
    $cur__man       \
    $cur__doc       \
    $cur__share     \
    $cur__etc
}

esy-shell () {
  /bin/bash \
    --noprofile \
    --rcfile <(echo "export PS1=\"[$cur__name sandbox] $ \"; source $ESY__RUNTIME")
}

esy-build-archive () {
  # TODO: we depend on GNU tar here, make sure we get rid of that
  gtar \
    -czf $cur__install_key.tar.gz \
    --transform "s,^\.,$cur__install_key," \
    -C $cur__install .
}

esy-build-command () {
  set +e
  BUILD_CMD=`node \
    -p "let pjc = require(\"$cur__root/package.json\").pjc; ((pjc || {}).build || 'true')"`
  /bin/bash --noprofile --norc -c "$BUILD_CMD" > $esy__store/_logs/$cur__install_key.build.log 2>&1
  set -e
  if [ "$?" != "0" ]; then
    esy-clean
    echo "Build failied, see $esy__store/_logs/$cur__install_key.build.log for details"
    exit 1
  fi
}

esy-clean () {
  rm -rf $cur__install
  rm -rf $cur__target_dir
}

esy-build () {
  if [ ! -d "$cur__install" ]; then
    echo -n "Checking if cached build artifact is available... "
    cache_build_status=`esy-build-download-status`
    if [ "$cache_build_status" != "404" ]; then
      echo "found, downloading... "
      esy-build-download
    else
      echo "not found, building from sources..."
      esy-prepare-install-tree
      esy-build-command
    fi
  fi
}
