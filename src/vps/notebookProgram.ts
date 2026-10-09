/** Preserve notebook cell boundaries, state and IPython syntax in a fresh job. */
export function pythonNotebookProgram(cells: readonly string[]): string {
  // JSON avoids source interpolation: cell text is data until the selected
  // Python environment compiles it, including quotes and Unicode filenames.
  return `import json as _pair_json
_pair_cells = _pair_json.loads(${JSON.stringify(JSON.stringify(cells))})
_pair_namespace = {"__name__": "__main__", "__file__": __file__, "__builtins__": __builtins__}
try:
    from IPython.core.interactiveshell import InteractiveShell as _pair_shell_type
except ImportError:
    _pair_shell_type = None
if _pair_shell_type is not None:
    _pair_shell = _pair_shell_type.instance()
    _pair_shell.user_ns.update(_pair_namespace)
    for _pair_cell in _pair_cells:
        _pair_result = _pair_shell.run_cell(_pair_cell, store_history=False)
        if _pair_result.error_before_exec is not None or _pair_result.error_in_exec is not None:
            raise SystemExit(1)
else:
    import __future__ as _pair_future
    _pair_flags = 0
    _pair_future_mask = sum(getattr(_pair_future, _pair_name).compiler_flag for _pair_name in _pair_future.all_feature_names)
    for _pair_index, _pair_cell in enumerate(_pair_cells, 1):
        _pair_code = compile(_pair_cell, __file__ + "#cell-" + str(_pair_index), "exec", flags=_pair_flags, dont_inherit=True)
        _pair_flags |= _pair_code.co_flags & _pair_future_mask
        exec(_pair_code, _pair_namespace, _pair_namespace)
`;
}
