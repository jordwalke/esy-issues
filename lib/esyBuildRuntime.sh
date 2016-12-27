set -e
set -u
set -o pipefail

ESY__BUILD_COMMAND="
let esy = require(\"$cur__root/package.json\").esy || {};\
let build = esy.build || 'true';\
build = Array.isArray(build) ? build.join(' && ') : build;\
build;"

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

esy-build-command () {
  BUILD_LOG="$esy__store/_logs/$cur__install_key.build.log"
  BUILD_CMD=`node -p "$ESY__BUILD_COMMAND"`
  set +e
  /bin/bash             \
    --noprofile --norc  \
    -e -u -o pipefail   \
    -c "$BUILD_CMD"     \
    > "$BUILD_LOG" 2>&1
  BUILD_RETURN_CODE="$?"
  set -e
  if [ "$BUILD_RETURN_CODE" != "0" ]; then
    echo "*** $cur__name: build failied, see $BUILD_LOG for details"
    esy-clean
    exit 1
  else
    echo "*** $cur__name: build complete"
  fi
}

esy-clean () {
  rm -rf $cur__install
  rm -rf $cur__target_dir
}

esy-build () {
  # TODO: that's a fragile check, we need to build in another location and then
  # mv to the $cur__install. Why we don't do this now is because we don't
  # assume everything we build is relocatable.
  if [ ! -d "$cur__install" ]; then
    echo "*** $cur__name: building from source... "
    esy-prepare-install-tree
    # TODO: we need proper locking mechanism here
    esy-build-command
  fi
}
