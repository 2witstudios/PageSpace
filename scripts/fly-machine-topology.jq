if type != "array" then error("Machine inventory is not an array") else . end
| map({group: .config.metadata.fly_process_group, region: .region})
| if any(.[]; (.group | type) != "string" or (.region | type) != "string")
  then error("Machine lacks a managed process group or region") else . end
| if any(.[]; (.group | test("^[a-zA-Z0-9_-]+$") | not) or (.region | test("^[a-z0-9_-]+$") | not))
  then error("Invalid process group or region") else . end
| group_by([.group, .region])
| map({group: .[0].group, region: .[0].region, count: length})
