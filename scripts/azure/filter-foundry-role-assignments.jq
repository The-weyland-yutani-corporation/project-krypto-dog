def require_string($value; $field):
  if ($value | type) == "string" and ($value | length) > 0 then
    $value
  else
    error("missing or invalid role-assignment field: " + $field)
  end;

($account_id | ascii_downcase) as $normalized_account_id
| (
    [
      $effective[]
      | {
          id: require_string(.id; "id"),
          scope: require_string(.scope; "scope"),
          roleDefinitionId: require_string(.roleDefinitionId; "roleDefinitionId"),
          principalId: require_string(.principalId; "principalId"),
          principalType: require_string(.principalType; "principalType")
        }
    ]
    +
    [
      $direct[]
      | {
          id: require_string(.id; "id"),
          scope: require_string(.properties.scope; "properties.scope"),
          roleDefinitionId: require_string(.properties.roleDefinitionId; "properties.roleDefinitionId"),
          principalId: require_string(.properties.principalId; "properties.principalId"),
          principalType: require_string(.properties.principalType; "properties.principalType")
        }
      | select(
          ((.scope | ascii_downcase) == $normalized_account_id) or
          ((.scope | ascii_downcase) | startswith($normalized_account_id + "/"))
        )
    ]
  )
| unique_by(.id | ascii_downcase)
