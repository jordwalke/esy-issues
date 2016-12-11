open Solvuu_build.Std

let project_name = "PackageA"
let version = "dev"

let lib = Project.lib project_name
  ~dir: "lib"
  ~findlib_deps: ["PackageB"]
  ~style:(`Pack project_name)
  ~pkg: project_name

let app = Project.app "hello"
  ~file: "bin/package_a_cmd.ml"
  ~findlib_deps: ["PackageB"]

let () = Project.basic1 ~project_name ~version [lib; app]
