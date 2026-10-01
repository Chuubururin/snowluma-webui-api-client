module example.com/sl/adapters

go 1.27.1

require example.com/sl/generated v0.0.0

require (
	github.com/apapsch/go-jsonmerge/v2 v2.0.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/oapi-codegen/runtime v1.7.0 // indirect
)

replace example.com/sl/generated => ../../generated/go
