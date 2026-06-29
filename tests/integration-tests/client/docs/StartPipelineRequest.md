# StartPipelineRequest

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**default_font** | Option<**String**> |  | [optional]
**pages** | Option<**Vec<uuid::Uuid>**> | `None` → whole project, `Some(pages)` → just those pages. | [optional]
**reading_order** | Option<[**models::ReadingOrder**](ReadingOrder.md)> |  | [optional]
**region** | Option<[**models::Region**](Region.md)> | Optional bounding-box hint for inpainter engines (repair-brush). | [optional]
**steps** | **Vec<String>** | Engine ids (`inventory::submit!` ids) to run in order. | 
**system_prompt** | Option<**String**> |  | [optional]
**target_language** | Option<**String**> |  | [optional]
**text_node_ids** | Option<**Vec<uuid::Uuid>**> | Optional text-node ids for engines that can operate on individual blocks. | [optional]

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


